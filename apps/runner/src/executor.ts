import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AdapterContext, TaskEnvelope } from "@aipeople/contracts";
import { verifyEnvelopeBinding } from "@aipeople/contracts";
import { SimulatorAdapter } from "@aipeople/connector-simulator";
import { WeiboCliAdapter } from "@aipeople/connector-weibo";
import type { PlatformAdapter } from "@aipeople/contracts";
import type { RunnerConfig, RunnerStore } from "./storage.js";

const adapters: Record<string, PlatformAdapter> = {
  simulator: new SimulatorAdapter(),
  weibo_cli: new WeiboCliAdapter(),
};

/**
 * 串行执行一个任务信封（方案 §4.3）：
 * 校验绑定 → 落盘提交意图 → 适配器执行 → 结果落盘 → 上报（断网重试）。
 */
export async function executeEnvelope(
  envelope: TaskEnvelope,
  config: RunnerConfig,
  store: RunnerStore,
  dataDir: string,
): Promise<FinishedResult> {
  const binding = verifyEnvelopeBinding(envelope, {
    runnerId: config.runnerId,
    workspaceId: config.workspaceId,
    accountIds: [envelope.accountId], // 账号绑定由服务端领取接口保证；此处校验设备与工作空间
  });
  if (!binding.ok) {
    return finished(envelope, {
      outcome: "failed",
      errorCode: "internal",
      errorMessage: `信封校验失败：${binding.reason}`,
    });
  }

  const adapter = adapters[envelope.channel];
  if (!adapter) {
    return finished(envelope, {
      outcome: "failed",
      errorCode: "not_configured",
      errorMessage: `本设备没有通道适配器：${envelope.channel}`,
    });
  }

  store.writeJournal({
    taskId: envelope.taskId,
    attemptId: envelope.attemptId,
    phase: "claim",
    createdAt: new Date().toISOString(),
  });

  const ctx: AdapterContext = {
    envelope,
    resolveSecret: async () => resolveSecret(envelope, config, dataDir),
    log: (message, detail) => console.log(`[runner] ${message}`, detail ?? ""),
  };

  // 不可逆提交前落盘 COMMIT_INTENT：断电/断网后进入 UNKNOWN 对账，不盲目重试
  store.writeJournal({
    taskId: envelope.taskId,
    attemptId: envelope.attemptId,
    phase: "commit_intent",
    createdAt: new Date().toISOString(),
  });

  try {
    const result = await adapter.submit(ctx);
    const runnerResult = finished(envelope, result);
    store.saveReceipt(runnerResult);
    store.clearJournal(envelope.taskId, envelope.attemptId);
    return runnerResult;
  } catch (error) {
    const runnerResult = finished(envelope, {
      outcome: "unknown",
      errorCode: "internal",
      errorMessage: `适配器异常退出（提交状态未知）：${error instanceof Error ? error.message : String(error)}`,
    });
    store.saveReceipt(runnerResult);
    return runnerResult;
  }
}

interface FinishedResult {
  taskId: string;
  attemptId: string;
  outcome: string;
  externalId: string | null;
  url: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  raw: unknown;
  finishedAt: string;
  reportedAt: null;
}

function finished(
  envelope: TaskEnvelope,
  result: { outcome: string; errorCode?: string | null; errorMessage?: string | null; externalId?: string | null; url?: string | null; raw?: unknown },
): FinishedResult {
  return {
    taskId: envelope.taskId,
    attemptId: envelope.attemptId,
    outcome: result.outcome,
    externalId: result.externalId ?? null,
    url: result.url ?? null,
    errorCode: result.errorCode ?? null,
    errorMessage: result.errorMessage ?? null,
    raw: result.raw ?? null,
    finishedAt: new Date().toISOString(),
    reportedAt: null,
  };
}

/**
 * 凭据解析：优先本地凭据库（vault/{accountId}.json，方案 §6 本地优先），
 * 否则向后台按需获取（仅限分配给本设备的在途任务）。
 */
async function resolveSecret(
  envelope: TaskEnvelope,
  config: RunnerConfig,
  dataDir: string,
): Promise<Record<string, string> | null> {
  const localVault = join(dataDir, "vault", `${envelope.accountId}.json`);
  if (existsSync(localVault)) {
    try {
      return JSON.parse(readFileSync(localVault, "utf8")) as Record<string, string>;
    } catch {
      console.warn("[runner] 本地凭据库文件损坏，改用服务端凭据");
    }
  }
  const response = await fetch(`${config.backendUrl}/runner/secrets`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-device-token": config.deviceToken },
    body: JSON.stringify({ accountId: envelope.accountId }),
  });
  if (!response.ok) {
    console.warn(`[runner] 服务端凭据获取失败（${response.status}）`);
    return null;
  }
  const data = (await response.json()) as { secret: Record<string, string> };
  return data.secret;
}
