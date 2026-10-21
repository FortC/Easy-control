import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { getDb } from "@aipeople/server-kit";
import { RunnerResultSchema } from "@aipeople/contracts";
import { requireUser, requireAdmin, type AuthedRequest } from "../auth.js";
import {
  authenticateRunner,
  claimNextTask,
  createPairingCode,
  fetchSecretForRunner,
  ingestRunnerResult,
  pairRunner,
  revokeRunner,
  updateHeartbeat,
  type RunnerRow,
} from "@aipeople/orchestration";

interface RunnerAuthedRequest extends FastifyRequest {
  runner: RunnerRow;
}

async function requireRunner(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = request.headers["x-device-token"];
  if (typeof token !== "string" || token.length === 0) {
    await reply.code(401).send({ error: "unauthorized", message: "缺少设备令牌" });
    return;
  }
  const runner = await authenticateRunner(token);
  if (!runner) {
    await reply.code(401).send({ error: "unauthorized", message: "设备令牌无效或已撤销" });
    return;
  }
  (request as RunnerAuthedRequest).runner = runner;
}

export async function runnerRoutes(app: FastifyInstance): Promise<void> {
  // ---- 工作台侧 ----

  app.post("/runners/pairing-codes", { preHandler: requireAdmin }, async (request) => {
    const ws = (request as AuthedRequest).user.ws;
    const { code, expiresAt } = await createPairingCode(ws);
    return { code, expiresAt: expiresAt.toISOString(), hint: "在执行设备上运行：pnpm dev:runner -- --pair <code>" };
  });

  app.get("/runners", { preHandler: requireUser }, async (request) => {
    const ws = (request as AuthedRequest).user.ws;
    const { rows } = await getDb().query(
      `SELECT r.id, r.name, r.adapters, r.last_heartbeat_at, r.created_at,
              (r.last_heartbeat_at > now() - interval '90 seconds') AS online
       FROM runners r WHERE r.workspace_id = $1 AND r.status = 'paired' ORDER BY r.created_at`,
      [ws],
    );
    return { runners: rows };
  });

  app.delete("/runners/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const ws = (request as AuthedRequest).user.ws;
    const ok = await revokeRunner(ws, id);
    if (!ok) return reply.code(404).send({ error: "not_found", message: "设备不存在或已撤销" });
    return { ok: true };
  });

  // ---- Runner 侧（设备令牌认证） ----

  /** 配对：一次性码换设备凭据。公开接口，凭配对码授权。 */
  app.post("/runners/pair", async (request, reply) => {
    const body = z
      .object({
        code: z.string().min(1),
        name: z.string().min(1).default("Windows 执行设备"),
        adapters: z.array(z.enum(["simulator", "weibo_cli", "douyin_api"])).default(["simulator", "weibo_cli"]),
      })
      .safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request", message: body.error.issues[0]?.message });
    const result = await pairRunner(body.data.code, body.data.name, body.data.adapters);
    if (!result.ok) return reply.code(400).send({ error: "pair_failed", message: result.message });
    return { runnerId: result.runnerId, deviceToken: result.deviceToken, workspaceId: result.workspaceId };
  });

  app.post("/runner/heartbeat", { preHandler: requireRunner }, async (request) => {
    await updateHeartbeat((request as RunnerAuthedRequest).runner.id);
    return { ok: true, intervalMs: 30_000 };
  });

  /** 长轮询领取任务信封。 */
  app.post("/runner/claim", { preHandler: requireRunner }, async (request, reply) => {
    const runner = (request as RunnerAuthedRequest).runner;
    const body = z.object({ waitMs: z.number().int().min(0).max(30_000).default(20_000) }).parse(request.body ?? {});
    const envelope = await claimNextTask({ runnerId: runner.id, waitMs: body.waitMs });
    return { task: envelope };
  });

  /** 结果上报：幂等（task+attempt 唯一），断网重试安全。 */
  app.post("/runner-results", { preHandler: requireRunner }, async (request, reply) => {
    const runner = (request as RunnerAuthedRequest).runner;
    const body = RunnerResultSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request", message: body.error.issues[0]?.message });
    const result = await ingestRunnerResult(body.data, { runnerId: runner.id });
    if (!result.ok) return reply.code(400).send({ error: "ingest_failed", message: result.message });
    return { ok: true, ignored: result.ignored ?? false };
  });

  /** 按需取账号凭据（仅限分配给该设备的在途任务账号）。 */
  app.post("/runner/secrets", { preHandler: requireRunner }, async (request, reply) => {
    const runner = (request as RunnerAuthedRequest).runner;
    const body = z.object({ accountId: z.string().min(1) }).parse(request.body ?? {});
    const result = await fetchSecretForRunner(runner.id, body.accountId);
    if (!result.ok) return reply.code(403).send({ error: "secret_denied", message: result.message });
    return { secret: result.secret };
  });
}
