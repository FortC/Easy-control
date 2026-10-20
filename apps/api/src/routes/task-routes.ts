import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getDb, withTransaction } from "@aipeople/server-kit";
import { canTransition } from "@aipeople/contracts";
import { transitionTaskState, recordEvent } from "@aipeople/orchestration";
import { requireUser, type AuthedRequest } from "../auth.js";

export async function taskRoutes(app: FastifyInstance): Promise<void> {
  app.get("/tasks", { preHandler: requireUser }, async (request) => {
    const ws = (request as AuthedRequest).user.ws;
    const query = z
      .object({ status: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(request.query ?? {});
    const params: unknown[] = [ws];
    let filter = "";
    if (query.status) {
      params.push(query.status);
      filter = `AND t.status = $${params.length}`;
    }
    const { rows } = await getDb().query(
      `SELECT t.id, t.status, t.platform, t.channel, t.action, t.occurrence_at, t.execution_window_end,
              t.last_error, t.attempts, t.updated_at, t.scenario,
              ac.display_name AS account_name, ac.uid AS account_uid, cv.title AS content_title,
              p.publication_status, p.url AS publication_url, p.external_id
       FROM tasks t
       JOIN account_connections ac ON ac.id = t.account_id
       JOIN content_versions cv ON cv.id = t.content_version_id
       LEFT JOIN publications p ON p.task_id = t.id
       WHERE t.workspace_id = $1 ${filter}
       ORDER BY t.occurrence_at DESC LIMIT $${params.length + 1}`,
      [...params, query.limit],
    );
    return { tasks: rows };
  });

  app.get("/tasks/:id", { preHandler: requireUser }, async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const ws = (request as AuthedRequest).user.ws;
    const task = (
      await getDb().query(
        `SELECT t.*, ac.display_name AS account_name, ac.uid AS account_uid, cv.title AS content_title, cv.body AS content_body
         FROM tasks t
         JOIN account_connections ac ON ac.id = t.account_id
         JOIN content_versions cv ON cv.id = t.content_version_id
         WHERE t.workspace_id = $1 AND t.id = $2`,
        [ws, id],
      )
    ).rows[0];
    if (!task) return reply.code(404).send({ error: "not_found", message: "任务不存在" });
    const attempts = await getDb().query(
      `SELECT id, attempt_no, started_at, finished_at, outcome, error_code, error_message FROM task_attempts
       WHERE task_id = $1 ORDER BY attempt_no DESC`,
      [id],
    );
    const publications = await getDb().query(`SELECT * FROM publications WHERE task_id = $1`, [id]);
    const events = await getDb().query(
      `SELECT id, type, payload, created_at FROM events WHERE workspace_id = $1 AND task_id = $2 ORDER BY id ASC LIMIT 100`,
      [ws, id],
    );
    return { task, attempts: attempts.rows, publication: publications.rows[0] ?? null, events: events.rows };
  });

  /** 取消：只允许未进入执行/已明确的终态之外的状态。 */
  app.post("/tasks/:id/cancel", { preHandler: requireUser }, async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const ws = (request as AuthedRequest).user.ws;
    const task = (
      await getDb().query<{ status: string }>(`SELECT status FROM tasks WHERE workspace_id = $1 AND id = $2`, [ws, id])
    ).rows[0];
    if (!task) return reply.code(404).send({ error: "not_found", message: "任务不存在" });
    if (!canTransition(task.status as never, "CANCELLED")) {
      return reply.code(400).send({
        error: "bad_request",
        message: "任务已在执行或已结束；已提交平台的内容可能无法撤回，请到平台处理",
      });
    }
    await withTransaction(async (client) => {
      await transitionTaskState(client, ws, id, task.status as never, "CANCELLED", {
        lastError: { code: "user_cancelled", message: "用户取消" },
      });
    });
    return { ok: true };
  });

  /** 人工处理 NEEDS_HUMAN：重新排期或取消。 */
  app.post("/tasks/:id/resolve", { preHandler: requireUser }, async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({ decision: z.enum(["reschedule", "cancel"]), at: z.string().optional() })
      .safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "bad_request", message: body.error.issues[0]?.message });
    const ws = (request as AuthedRequest).user.ws;
    const task = (
      await getDb().query<{ status: string; execution_window_end: Date; occurrence_at: Date }>(
        `SELECT status, execution_window_end, occurrence_at FROM tasks WHERE workspace_id = $1 AND id = $2`,
        [ws, id],
      )
    ).rows[0];
    if (!task) return reply.code(404).send({ error: "not_found", message: "任务不存在" });
    if (task.status !== "NEEDS_HUMAN") {
      return reply.code(400).send({ error: "bad_request", message: "任务不在需人工处理状态" });
    }
    await withTransaction(async (client) => {
      if (body.data.decision === "cancel") {
        await transitionTaskState(client, ws, id, "NEEDS_HUMAN", "CANCELLED", {
          lastError: { code: "resolved_cancel", message: "人工处理：取消" },
        });
        return;
      }
      const newAt = body.data.at ? new Date(body.data.at) : new Date(Date.now() + 5 * 60_000);
      await transitionTaskState(client, ws, id, "NEEDS_HUMAN", "SCHEDULED", {
        lastError: { code: "resolved_reschedule", message: "人工处理：重新排期" },
      });
      await client.query(
        `UPDATE tasks SET occurrence_at = $3,
           execution_window_start = $3,
           execution_window_end = $3 + interval '30 minutes',
           updated_at = now()
         WHERE workspace_id = $1 AND id = $2`,
        [ws, id, newAt],
      );
      await recordEvent(client, {
        workspaceId: ws,
        taskId: id,
        type: "task.state_changed",
        payload: { from: "NEEDS_HUMAN", to: "SCHEDULED", rescheduledAt: newAt.toISOString() },
        dedupeKey: `resolve:${id}:${Date.now()}`,
      });
    });
    return { ok: true };
  });

  /** 事件流：断线后按序号补拉（方案 §10）。 */
  app.get("/task-events", { preHandler: requireUser }, async (request) => {
    const ws = (request as AuthedRequest).user.ws;
    const query = z
      .object({ after: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(500).default(100) })
      .parse(request.query ?? {});
    const { rows } = await getDb().query(
      `SELECT id, task_id, account_id, type, payload, created_at FROM events
       WHERE workspace_id = $1 AND id > $2 ORDER BY id ASC LIMIT $3`,
      [ws, query.after, query.limit],
    );
    return { events: rows };
  });
}
