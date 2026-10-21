/**
 * 独立模式内嵌后端入口（由 esbuild 打包为 electron/backend.cjs，随桌面应用分发）：
 * 在 Electron 主进程内启动 Fastify API、调度循环与执行器循环，
 * 数据库为应用自管理的进程内 PGlite（由 Electron 独立主进程初始化）。
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getDb, decryptSecret, closeDb } from "@aipeople/server-kit";
import {
  adapterFor,
  advanceSimulatorReview,
  claimNextTask,
  ingestRunnerResult,
  markStaleRunnersOffline,
  materializeDueSchedules,
  reconcileUnknownTasks,
  releaseDueTasks,
  sweepStaleWaitingTasks,
} from "@aipeople/orchestration";
import { buildServer } from "../../../apps/api/src/server.js";
import type { AdapterContext, TaskEnvelope } from "@aipeople/contracts";

let running = false;
const timers: NodeJS.Timeout[] = [];

/** 幂等执行 SQL 迁移（与 Windows 本机嵌入式数据库配套）。 */
async function runMigrations(migrationsDir: string): Promise<void> {
  const client = await getDb().connect();
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS applied_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const applied = new Set(
      (await client.query<{ filename: string }>(`SELECT filename FROM applied_migrations`)).rows.map(
        (r: { filename: string }) => r.filename,
      ),
    );
    if (!existsSync(migrationsDir)) throw new Error(`迁移目录缺失：${migrationsDir}`);
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      await client.query("BEGIN");
      try {
        await client.query(readFileSync(join(migrationsDir, file), "utf8"));
        await client.query(`INSERT INTO applied_migrations (filename) VALUES ($1)`, [file]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`迁移 ${file} 失败：${error instanceof Error ? error.message : error}`);
      }
    }
  } finally {
    client.release();
  }
}

/** 独立模式凭据解析：直接读服务端加密副本（同机部署，无需 Runner 通道）。 */
async function resolveSecretFromDb(envelope: TaskEnvelope): Promise<Record<string, string> | null> {
  const { rows } = await getDb().query<{ secret_encrypted: string | null }>(
    `SELECT secret_encrypted FROM account_connections WHERE id = $1 AND workspace_id = $2`,
    [envelope.accountId, envelope.workspaceId],
  );
  const encrypted = rows[0]?.secret_encrypted;
  if (!encrypted) return null;
  const decrypted = decryptSecret(encrypted);
  if (!decrypted) return null;
  try {
    return JSON.parse(decrypted) as Record<string, string>;
  } catch {
    return null;
  }
}

/** 执行器循环：领取任意通道的到期任务并串行执行（含模拟平台审核推进的配套循环）。 */
async function executorLoop(): Promise<void> {
  while (running) {
    try {
      const envelope = await claimNextTask({ waitMs: 3000 });
      if (!envelope) continue;
      const adapter = adapterFor(envelope.channel);
      const ctx: AdapterContext = {
        envelope,
        resolveSecret: () => resolveSecretFromDb(envelope),
        log: (message: string, detail?: unknown) => console.log(`[app] ${message}`, detail ?? ""),
      };
      let result;
      try {
        result = await adapter.submit(ctx);
      } catch (error) {
        result = {
          outcome: "unknown" as const,
          errorCode: "internal" as const,
          errorMessage: `适配器异常退出（提交状态未知）：${error instanceof Error ? error.message : String(error)}`,
        };
      }
      await ingestRunnerResult(
        {
          taskId: envelope.taskId,
          attemptId: envelope.attemptId,
          outcome: result.outcome,
          externalId: result.externalId ?? null,
          url: result.url ?? null,
          errorCode: result.errorCode ?? null,
          errorMessage: result.errorMessage ?? null,
          raw: result.raw,
          finishedAt: new Date().toISOString(),
        },
        { runnerId: null },
      );
    } catch (error) {
      console.error("[app] 执行循环异常：", error instanceof Error ? error.message : error);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

export interface EmbeddedBackendOptions {
  /** API 监听端口（绑定 127.0.0.1）。 */
  port: number;
  /** SQL 迁移目录。 */
  migrationsDir: string;
}

export interface EmbeddedBackendHandle {
  port: number;
  stop(): Promise<void>;
}

async function startEmbeddedBackend(options: EmbeddedBackendOptions): Promise<EmbeddedBackendHandle> {
  running = true;
  await runMigrations(options.migrationsDir);

  const server = await buildServer();
  await server.listen({ port: options.port, host: "127.0.0.1" });

  timers.push(setInterval(() => void releaseDueTasks().catch(() => {}), 10_000));
  timers.push(setInterval(() => void sweepStaleWaitingTasks().catch(() => {}), 30_000));
  timers.push(setInterval(() => void materializeDueSchedules().catch(() => {}), 60_000));
  timers.push(setInterval(() => void advanceSimulatorReview().catch(() => {}), 2_000));
  timers.push(
    setInterval(() => {
      void reconcileUnknownTasks().catch(() => {});
      void markStaleRunnersOffline().catch(() => {});
    }, 60_000),
  );
  void releaseDueTasks().catch(() => {});
  void executorLoop();

  console.log(`[app] 内嵌后台已启动：http://127.0.0.1:${options.port}`);
  return {
    port: options.port,
    stop: async () => {
      running = false;
      for (const timer of timers) clearInterval(timer);
      try {
        await server.close();
        await closeDb();
      } catch {
        /* 退出清理尽力而为 */
      }
    },
  };
}

export { startEmbeddedBackend };

