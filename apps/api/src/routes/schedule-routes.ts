import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getDb, randomId } from "@aipeople/server-kit";
import { CreateScheduleSchema, occurrenceIdempotencyKey } from "@aipeople/contracts";
import { materializeSingleScheduleNow } from "@aipeople/orchestration";
import { requireUser, requireEditor, type AuthedRequest } from "../auth.js";

export async function scheduleRoutes(app: FastifyInstance): Promise<void> {
  app.get("/schedules", { preHandler: requireUser }, async (request) => {
    const ws = (request as AuthedRequest).user.ws;
    const { rows } = await getDb().query(
      `SELECT s.*, cv.title AS content_title, ac.display_name AS account_name,
         (SELECT COUNT(*) FROM tasks t WHERE t.schedule_id = s.id AND t.status IN ('SCHEDULED','PREFLIGHT','WAITING_RUNNER','RUNNING')) AS upcoming_count
       FROM schedules s
       JOIN content_versions cv ON cv.id = s.content_version_id
       JOIN account_connections ac ON ac.id = s.account_id
       WHERE s.workspace_id = $1 ORDER BY s.created_at DESC LIMIT 100`,
      [ws],
    );
    return { schedules: rows };
  });

  /** 创建计划：单次同步物化任务；周期由 Worker 滚动物化（方案 §8）。 */
  app.post("/schedules", { preHandler: requireEditor }, async (request, reply) => {
    const body = CreateScheduleSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request", message: body.error.issues[0]?.message });
    if (body.data.platform === "xiaohongshu") {
      return reply.code(400).send({ error: "human_delivery_only", message: "第一版小红书仅支持内容生成、人工审核和复制导出；请由真人登录平台完成交付。" });
    }
    const ws = (request as AuthedRequest).user.ws;
    const user = (request as AuthedRequest).user;

    const db = getDb();
    const approval = (
      await db.query<{ id: string; status: string; content_hash: string; account_id: string; action: string; platform: string; expires_at: Date }>(
        `SELECT id, status, content_hash, account_id, action, platform, expires_at FROM approvals
         WHERE workspace_id = $1 AND id = $2`,
        [ws, body.data.approvalId],
      )
    ).rows[0];
    if (!approval || approval.status !== "active") {
      return reply.code(400).send({ error: "bad_request", message: "审批不存在或已失效" });
    }
    if (approval.account_id !== body.data.accountId || approval.action !== body.data.action || approval.platform !== body.data.platform) {
      return reply.code(400).send({ error: "bad_request", message: "计划与审批绑定的账号/动作/平台不一致" });
    }
    const content = (
      await db.query<{ hash: string }>(`SELECT hash FROM content_versions WHERE workspace_id = $1 AND id = $2`, [
        ws,
        body.data.contentVersionId,
      ])
    ).rows[0];
    if (!content || content.hash !== approval.content_hash) {
      return reply.code(400).send({ error: "bad_request", message: "内容在审批后被修改，请重新审核" });
    }
    if (body.data.mode === "single" && new Date(body.data.at!).getTime() > approval.expires_at.getTime()) {
      return reply.code(400).send({ error: "bad_request", message: "发布时间晚于审批有效期" });
    }

    const scheduleId = randomId("sched");
    await db.query(
      `INSERT INTO schedules (id, workspace_id, mode, platform, account_id, action, content_version_id, approval_id,
         timezone, at, weekdays, time_of_day, start_date, until_date, expire_minutes, active, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, true, $16)`,
      [
        scheduleId,
        ws,
        body.data.mode,
        body.data.platform,
        body.data.accountId,
        body.data.action,
        body.data.contentVersionId,
        body.data.approvalId,
        body.data.timezone,
        body.data.mode === "single" ? new Date(body.data.at!) : null,
        JSON.stringify(body.data.weekdays),
        body.data.timeOfDay ?? null,
        body.data.startDate ?? null,
        body.data.untilDate ?? null,
        body.data.expireMinutes,
        user.sub,
      ],
    );
    let taskId: string | null = null;
    if (body.data.mode === "single") {
      taskId = await materializeSingleScheduleNow(scheduleId);
      if (!taskId) {
        const key = occurrenceIdempotencyKey(scheduleId, new Date(body.data.at!), body.data.accountId, body.data.action);
        const existing = await db.query<{ id: string }>(`SELECT id FROM tasks WHERE idempotency_key = $1`, [key]);
        taskId = existing.rows[0]?.id ?? null;
      }
    }
    return reply.code(201).send({ scheduleId, taskId });
  });

  /** 暂停/恢复：暂停时取消未开始任务（发放环节也会核对 active）。 */
  app.patch("/schedules/:id", { preHandler: requireEditor }, async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ active: z.boolean() }).parse(request.body ?? {});
    const ws = (request as AuthedRequest).user.ws;
    const result = await getDb().query(
      `UPDATE schedules SET active = $3 WHERE workspace_id = $1 AND id = $2 RETURNING id`,
      [ws, id, body.active],
    );
    if (!result.rowCount) return reply.code(404).send({ error: "not_found", message: "计划不存在" });
    if (!body.active) {
      await getDb().query(
        `UPDATE tasks SET status = 'CANCELLED', updated_at = now(),
           last_error = '{"code":"schedule_paused","message":"计划已暂停"}'
         WHERE workspace_id = $1 AND schedule_id = $2 AND status IN ('SCHEDULED', 'PREFLIGHT')`,
        [ws, id],
      );
    }
    return { ok: true };
  });

  app.delete("/schedules/:id", { preHandler: requireEditor }, async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const ws = (request as AuthedRequest).user.ws;
    const result = await getDb().query(
      `UPDATE schedules SET active = false WHERE workspace_id = $1 AND id = $2 RETURNING id`,
      [ws, id],
    );
    if (!result.rowCount) return reply.code(404).send({ error: "not_found", message: "计划不存在" });
    await getDb().query(
      `UPDATE tasks SET status = 'CANCELLED', updated_at = now(),
         last_error = '{"code":"schedule_cancelled","message":"计划已删除"}'
       WHERE workspace_id = $1 AND schedule_id = $2 AND status IN ('SCHEDULED', 'PREFLIGHT', 'WAITING_RUNNER', 'NEEDS_HUMAN')`,
      [ws, id],
    );
    return { ok: true };
  });
}
