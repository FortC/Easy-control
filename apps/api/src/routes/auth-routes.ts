import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getDb, randomId } from "@aipeople/server-kit";
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
