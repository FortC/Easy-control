import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getDb, randomId, randomToken } from "@aipeople/server-kit";
import { hashPassword, verifyPassword, signUserToken, requireUser, type AuthedRequest } from "../auth.js";

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  displayName: z.string().min(1),
  workspaceName: z.string().min(1),
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});


export async function authRoutes(app: FastifyInstance): Promise<void> {
/**
 * 个人模式免登录：自动创建/复用本地账号（local@aipeople.local）并签发令牌。
 * 该端点无凭据校验，仅适用于后台只绑定本机/内网的部署；对外暴露 API 前必须禁用。
 */
app.post("/auth/local", async () => {
  const db = getDb();
  const email = "local@aipeople.local";
  let user = (
    await db.query<{ id: string; email: string; display_name: string }>(
      `SELECT id, email, display_name FROM users WHERE email = $1`,
      [email],
    )
  ).rows[0];

  if (!user) {
    const userId = randomId("user");
    const workspaceId = randomId("ws");
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO workspaces (id, name) VALUES ($1, $2)`, [workspaceId, "我的工作空间"]);
      await client.query(`INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, $3, $4)`, [
        userId,
        email,
        hashPassword(randomToken(16)),
        "本地用户",
      ]);
      await client.query(`INSERT INTO members (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`, [
        workspaceId,
        userId,
      ]);
      await client.query(
        `INSERT INTO model_providers (id, workspace_id, name, adapter, model, is_default)
         VALUES ($1, $2, '内置 Mock（演示）', 'mock', 'mock', true)`,
        [randomId("mp"), workspaceId],
      );
      const simulators = [
        { platform: "xiaohongshu", action: "publish_image_note", name: "小红书人工交付工作区" },
        { platform: "weibo", action: "publish_post", name: "模拟微博账号" },
        { platform: "douyin", action: "publish_video", name: "模拟抖音账号" },
      ];
      for (const sim of simulators) {
        const accountId = randomId("acct");
        await client.query(
          `INSERT INTO account_connections (id, workspace_id, platform, channel, uid, display_name, capabilities, risk_note)
           VALUES ($1, $2, $3, 'simulator', $4, $5, $6::jsonb, $7)`,
          [
            accountId,
            workspaceId,
            sim.platform,
            randomId("sim"),
            sim.name,
            JSON.stringify(sim.platform === "xiaohongshu" ? ["human_review", "content_export"] : [sim.action, "pull_metrics"]),
            sim.platform === "xiaohongshu" ? "人工交付工作区：不连接平台，不保存账号会话或凭据" : "演示通道，不连接真实平台",
          ],
        );
        await client.query(
          `INSERT INTO capability_grants (id, workspace_id, account_id, platform, action, channel, evidence)
           VALUES ($1, $2, $3, $4, $5, 'simulator', 'local_bootstrap')`,
          [randomId("grant"), workspaceId, accountId, sim.platform, sim.action],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    user = { id: userId, email, display_name: "本地用户" };
  }

  const membership = (
    await db.query<{ workspace_id: string; role: "admin" | "editor" | "reviewer" | "viewer" }>(
      `SELECT workspace_id, role FROM members WHERE user_id = $1 AND status = 'active' LIMIT 1`,
      [user.id],
    )
  ).rows[0];
  if (!membership) {
    throw Object.assign(new Error("本地账号未加入工作空间，请重试或重新初始化"), { statusCode: 500 });
  }
  const token = await signUserToken({
    sub: user.id,
    ws: membership.workspace_id,
    role: membership.role,
    name: user.display_name,
  });
  return {
    token,
    user: { id: user.id, email: user.email, displayName: user.display_name, workspaceId: membership.workspace_id, role: membership.role },
  };
});

  app.post("/auth/register", async (request, reply) => {
    const body = RegisterSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request", message: body.error.issues[0]?.message });
    const { email, password, displayName, workspaceName } = body.data;
    const db = getDb();
    const existing = await db.query(`SELECT id FROM users WHERE email = $1`, [email.toLowerCase()]);
    if (existing.rowCount && existing.rowCount > 0) {
      return reply.code(409).send({ error: "conflict", message: "该邮箱已注册" });
    }
    const userId = randomId("user");
    const workspaceId = randomId("ws");
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO workspaces (id, name) VALUES ($1, $2)`, [workspaceId, workspaceName]);
      await client.query(`INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, $3, $4)`, [
        userId,
        email.toLowerCase(),
        hashPassword(password),
        displayName,
      ]);
      await client.query(`INSERT INTO members (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`, [
        workspaceId,
        userId,
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    const token = await signUserToken({ sub: userId, ws: workspaceId, role: "admin", name: displayName });
    return reply.code(201).send({ token, user: { id: userId, email, displayName, workspaceId, role: "admin" } });
  });

  app.post("/auth/login", async (request, reply) => {
    const body = LoginSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request", message: "邮箱或密码格式不正确" });
    const db = getDb();
    const { rows } = await db.query<{ id: string; email: string; password_hash: string; display_name: string }>(
      `SELECT id, email, password_hash, display_name FROM users WHERE email = $1`,
      [body.data.email.toLowerCase()],
    );
    const user = rows[0];
    if (!user || !verifyPassword(body.data.password, user.password_hash)) {
      return reply.code(401).send({ error: "unauthorized", message: "邮箱或密码不正确" });
    }
    const membership = (
      await db.query<{ workspace_id: string; role: "admin" | "editor" | "reviewer" | "viewer" }>(
        `SELECT workspace_id, role FROM members WHERE user_id = $1 AND status = 'active' LIMIT 1`,
        [user.id],
      )
    ).rows[0];
    if (!membership) {
      return reply.code(403).send({ error: "forbidden", message: "该账号未加入任何工作空间" });
    }
    const token = await signUserToken({
      sub: user.id,
      ws: membership.workspace_id,
      role: membership.role,
      name: user.display_name,
    });
    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        workspaceId: membership.workspace_id,
        role: membership.role,
      },
    };
  });

  app.get("/me", { preHandler: requireUser }, async (request) => {
    const user = (request as AuthedRequest).user;
    const db = getDb();
    const { rows } = await db.query<{ name: string; timezone: string }>(
      `SELECT name, timezone FROM workspaces WHERE id = $1`,
      [user.ws],
    );
    return { user: { ...user, displayName: user.name }, workspace: rows[0] ?? null };
  });
}
