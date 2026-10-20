import PgBoss from "pg-boss";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile, requireEnv, getDb, decryptSecret } from "@aipeople/server-kit";
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
import type { AdapterContext, TaskEnvelope } from "@aipeople/contracts";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
loadEnvFile(rootDir);

async function main() {
  const connectionString = requireEnv("DATABASE_URL");
  const boss = new PgBoss({ connectionString, schema: "pgboss" });
  await boss.start();
  console.log("[worker] pg-boss 已启动");

  for (const queue of ["materialize", "reconcile", "release-task"]) {
    await boss.createQueue(queue);
  }

  // 分钟级持久任务（pg-boss）：调度物化、对账
  await boss.schedule("materialize", "* * * * *");
  await boss.schedule("reconcile", "* * * * *");
  await boss.work("materialize", async () => {
    const created = await materializeDueSchedules();
    if (created > 0) console.log(`[worker] 物化新任务 ${created} 个`);
  });
  await boss.work("reconcile", async () => {
    await reconcileUnknownTasks();
    await markStaleRunnersOffline();
  });

  // outbox → 精确投递（数据库扫描 tick 作为兜底，方案 §4.2/§8）
  await boss.work("release-task", async () => {
    await releaseDueTasks();
  });
  await dispatchOutbox(boss);

  // 进程内 tick：发放扫描 / 模拟平台审核推进 / 内部执行器
  setInterval(() => {
    releaseDueTasks().catch((error) => console.error("[worker] 发放失败：", error.message));
    sweepStaleWaitingTasks().catch(() => {});
  }, 10_000).unref();

  setInterval(() => {
    advanceSimulatorReview().catch(() => {});
  }, 2_000).unref();

  setInterval(() => {
    dispatchOutbox(boss).catch((error) => console.error("[worker] outbox 分发失败：", error.message));
  }, 5_000).unref();

  setInterval(() => {
    runInternalExecutor().catch((error) => console.error("[worker] 内部执行器失败：", error.message));
  }, 5_000).unref();

  console.log("[worker] 循环已启动：发放 10s / 审核 2s / outbox 5s / 内部执行器 5s");
}

/** 事务性 outbox 分发：业务事务写入的投递请求 → pg-boss 延迟任务。 */
async function dispatchOutbox(boss: PgBoss): Promise<void> {
  const db = getDb();
  const { rows } = await db.query<{ id: string; kind: string; payload: { taskId?: string; runAt?: string } }>(
    `SELECT id, kind, payload FROM outbox WHERE status = 'pending' ORDER BY id LIMIT 50`,
  );
  for (const row of rows) {
    if (row.kind === "release_at" && row.payload.taskId) {
      const startAfter = row.payload.runAt ? new Date(row.payload.runAt) : new Date();
      await boss.send("release-task", { taskId: row.payload.taskId }, { startAfter });
    }
    await db.query(`UPDATE outbox SET status = 'sent', sent_at = now() WHERE id = $1`, [row.id]);
  }
}

/**
 * 内部执行器：抖音官方 API 通道由后台 Worker 直接执行（方案 §4.4），
 * 凭据从服务端密钥存储解密，不经过任何桌面端或模型上下文。
 */
async function runInternalExecutor(): Promise<void> {
  const envelope = await claimNextTask({ internalChannel: "douyin_api", waitMs: 0 });
  if (!envelope) return;
  console.log(`[worker] 内部执行抖音任务 ${envelope.taskId}`);
  const adapter = adapterFor(envelope.channel);
  const ctx: AdapterContext = {
    envelope,
    resolveSecret: async () => resolveInternalSecret(envelope),
    log: (message, detail) => console.log(`[worker] ${message}`, detail ?? ""),
  };
  try {
    const result = await adapter.submit(ctx);
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
    await ingestRunnerResult(
      {
        taskId: envelope.taskId,
        attemptId: envelope.attemptId,
        outcome: "failed",
        errorCode: "internal",
        errorMessage: error instanceof Error ? error.message : String(error),
        finishedAt: new Date().toISOString(),
      },
      { runnerId: null },
    );
  }
}

async function resolveInternalSecret(envelope: TaskEnvelope): Promise<Record<string, string> | null> {
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

main().catch((error) => {
  console.error("[worker] 启动失败：", error);
  process.exit(1);
});
