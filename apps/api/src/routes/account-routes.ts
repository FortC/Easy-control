import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getDb, randomId, encryptSecret, withTransaction } from "@aipeople/server-kit";
import {
  CHANNEL_PLATFORMS,
  PUBLISH_ACTION_BY_PLATFORM,
  defaultChannelFor,
  isPlatform,
  type Channel,
  type Platform,
} from "@aipeople/contracts";
import { requireUser, requireEditor, type AuthedRequest } from "../auth.js";
import { recordEvent } from "@aipeople/orchestration";
import { channelCapabilities } from "@aipeople/orchestration";

const CreateAccountSchema = z.object({
  platform: z.string().refine(isPlatform, "平台必须是 xiaohongshu/weibo/douyin/zhihu"),
  channel: z.enum(["simulator", "weibo_cli", "douyin_api"]).optional(),
  uid: z.string().min(1).optional(),
  displayName: z.string().min(1).optional(),
  /** 仅用于已启用的官方平台通道；小红书第一版不接受平台凭据。 */
  secret: z.record(z.string()).optional(),
});

interface AccountRow {
  id: string;
  workspace_id: string;
  platform: Platform;
  channel: Channel;
  uid: string;
  display_name: string | null;
  session_status: string;
  capabilities: string[];
  paused: boolean;
  paused_reason: string | null;
  risk_note: string | null;
  created_at: Date;
}

function riskNoteFor(channel: Channel): string | null {
  switch (channel) {
    case "simulator":
      return "演示通道，不连接真实平台";
    case "weibo_cli":
      return "微博官方 CLI：需本机安装并完成 OAuth，发布 AI 内容需声明 AI 属性";
    case "douyin_api":
      return "抖音官方 API：需应用获批 video.create 权限并完成账号 OAuth";
  }
}

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.get("/accounts", { preHandler: requireUser }, async (request) => {
    const ws = (request as AuthedRequest).user.ws;
    const { rows } = await getDb().query<AccountRow>(
      `SELECT id, platform, channel, uid, display_name, session_status, capabilities, paused, paused_reason, risk_note, created_at
       FROM account_connections WHERE workspace_id = $1 ORDER BY created_at`,
      [ws],
    );
    return {
      accounts: rows.map((row) => ({
        ...row,
        capabilitiesDetail: channelCapabilities(row.channel),
        publishAction: PUBLISH_ACTION_BY_PLATFORM[row.platform],
      })),
    };
  });

  app.post("/accounts", { preHandler: requireEditor }, async (request, reply) => {
    const body = CreateAccountSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request", message: body.error.issues[0]?.message });
    const ws = (request as AuthedRequest).user.ws;
    const platform = body.data.platform as Platform;
    const channel = (body.data.channel ?? (platform === "xiaohongshu" && !body.data.secret ? "simulator" : defaultChannelFor(platform))) as Channel;
    if (!CHANNEL_PLATFORMS[channel].includes(platform)) {
      return reply.code(400).send({ error: "bad_request", message: `通道 ${channel} 不支持平台 ${platform}` });
    }
    if (platform === "xiaohongshu" && (channel !== "simulator" || body.data.secret)) {
      return reply.code(400).send({ error: "human_delivery_only", message: "第一版小红书不保存账号会话或凭据，请在软件外由真人登录并交付已审核内容。" });
    }
    const uid = body.data.uid ?? (channel === "simulator" ? randomId("sim") : "");
    if (!uid) {
      return reply.code(400).send({ error: "bad_request", message: "该通道需要提供账号 UID" });
    }
    const accountId = randomId("acct");
    const publishAction = PUBLISH_ACTION_BY_PLATFORM[platform];
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO account_connections (id, workspace_id, platform, channel, uid, display_name, secret_ref, secret_encrypted,
           capabilities, risk_note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
        [
          accountId,
          ws,
          platform,
          channel,
          uid,
          body.data.displayName ?? `${platform}:${uid}`,
          channel === "simulator" ? null : `vault:${accountId}`,
          body.data.secret ? encryptSecret(JSON.stringify(body.data.secret)) : null,
          JSON.stringify(channel === "simulator" ? [publishAction, "pull_metrics"] : [publishAction]),
          platform === "xiaohongshu" ? "人工交付工作区：不连接平台，不保存账号会话或凭据" : riskNoteFor(channel),
        ],
      );
      await client.query(
        `INSERT INTO capability_grants (id, workspace_id, account_id, platform, action, channel, evidence)
         VALUES ($7, $1, $2, $3, $4, $5, $6)`,
        [ws, accountId, platform, publishAction, channel, `account:${channel}`, randomId("grant")],
      );
      await recordEvent(client, {
        workspaceId: ws,
        accountId,
        type: "workspace.notice",
        payload: { message: `账号已连接：${body.data.displayName ?? uid}（${channel}）` },
        dedupeKey: `account_connected:${accountId}`,
      });
    });
    return reply.code(201).send({ id: accountId, uid, channel });
  });

  app.post("/accounts/:id/pause", { preHandler: requireEditor }, async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const ws = (request as AuthedRequest).user.ws;
    const body = z.object({ reason: z.string().default("手动暂停") }).parse(request.body ?? {});
    const result = await getDb().query(
      `UPDATE account_connections SET paused = true, paused_reason = $3 WHERE workspace_id = $1 AND id = $2`,
      [ws, id, body.reason],
    );
    if (!result.rowCount) return reply.code(404).send({ error: "not_found", message: "账号不存在" });
    return { ok: true };
  });

  app.post("/accounts/:id/resume", { preHandler: requireEditor }, async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const ws = (request as AuthedRequest).user.ws;
    const result = await getDb().query(
      `UPDATE account_connections SET paused = false, paused_reason = null, session_status = 'active'
       WHERE workspace_id = $1 AND id = $2`,
      [ws, id],
    );
    if (!result.rowCount) return reply.code(404).send({ error: "not_found", message: "账号不存在" });
    return { ok: true };
  });

  /** 断开账号：立即阻止新任务、取消未开始任务（方案 §6）。 */
  app.delete("/accounts/:id", { preHandler: requireEditor }, async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const ws = (request as AuthedRequest).user.ws;
    const done = await withTransaction(async (client) => {
      const found = await client.query(`SELECT id FROM account_connections WHERE workspace_id = $1 AND id = $2`, [ws, id]);
      if (!found.rows[0]) return false;
      await client.query(
        `UPDATE tasks SET status = 'CANCELLED', updated_at = now(),
           last_error = '{"code":"account_disconnected","message":"账号已断开"}'
         WHERE account_id = $2 AND workspace_id = $1 AND status IN ('SCHEDULED', 'PREFLIGHT', 'WAITING_RUNNER')`,
        [ws, id],
      );
      await client.query(`DELETE FROM account_connections WHERE workspace_id = $1 AND id = $2`, [ws, id]);
      await recordEvent(client, {
        workspaceId: ws,
        accountId: id,
        type: "workspace.notice",
        payload: { message: "账号已断开：未开始任务已取消，请到平台侧确认会话/授权撤销" },
        dedupeKey: `account_disconnected:${id}`,
      });
      return true;
    });
    if (!done) return reply.code(404).send({ error: "not_found", message: "账号不存在" });
    return { ok: true, note: "本地凭据已删除；平台侧会话请通过平台正常退出使其失效" };
  });
}
