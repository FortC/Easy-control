import { resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore, type RunnerConfig, type RunnerStore } from "./storage.js";
import { executeEnvelope } from "./executor.js";
import type { TaskEnvelope } from "@aipeople/contracts";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function loadEnv(): void {
  try {
    process.loadEnvFile(resolve(rootDir, ".env"));
  } catch {
    /* 使用进程环境变量 */
  }
}

function dataDir(): string {
  return resolve(rootDir, process.env.DATA_DIR ?? ".local", "runner");
}

async function pair(backendUrl: string, code: string, name: string, store: RunnerStore): Promise<void> {
  const response = await fetch(`${backendUrl}/runners/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, name, adapters: ["simulator", "weibo_cli"] }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(`配对失败：${body.message ?? response.status}`);
  }
  const result = (await response.json()) as { runnerId: string; deviceToken: string; workspaceId: string };
  const config: RunnerConfig = {
    backendUrl,
    runnerId: result.runnerId,
    deviceToken: result.deviceToken,
    workspaceId: result.workspaceId,
    name,
  };
  store.saveConfig(config);
  console.log(`[runner] 配对成功：${result.runnerId}（工作空间 ${result.workspaceId}）`);
}

async function main(): Promise<void> {
  loadEnv();
  const args = process.argv.slice(2);
  const backendUrl = process.env.RUNNER_BACKEND_URL ?? "http://localhost:8787";
  const store = openStore(dataDir());

  const pairArg = readArg(args, "--pair");
  if (pairArg) {
    const name = readArg(args, "--name") ?? `Windows 执行设备 (${new Date().toLocaleDateString("zh-CN")})`;
    await pair(backendUrl, pairArg, name, store);
    console.log("[runner] 现在直接运行 pnpm dev:runner 开始工作");
    return;
  }

  const config = store.loadConfig();
  if (!config) {
    console.error("[runner] 尚未配对。先运行：pnpm dev:runner -- --pair <配对码>");
    console.error("[runner] 配对码在工作台「总览 → 执行设备」页面生成。");
    process.exit(1);
  }
  console.log(`[runner] 已配对设备 ${config.runnerId} → ${config.backendUrl}`);

  // 断网重报：先补报未确认结果（服务端按 task+attempt 幂等去重）
  await reportPending(store, config);

  // 心跳
  setInterval(() => {
    void heartbeat(config);
  }, 30_000);
  void heartbeat(config);

  // 长轮询领取 + 串行执行
  let stopped = false;
  process.on("SIGINT", () => {
    stopped = true;
    console.log("[runner] 收到退出信号，等待当前循环结束…");
    process.exit(0);
  });

  while (!stopped) {
    try {
      const envelope = await claim(config);
      if (!envelope) continue;
      console.log(`[runner] 领取任务 ${envelope.taskId}（${envelope.platform}/${envelope.channel}/${envelope.action}）`);
      const result = await executeEnvelope(envelope, config, store, dataDir());
      await reportResult(result, store, config);
    } catch (error) {
      console.error("[runner] 循环异常：", error instanceof Error ? error.message : error);
      await sleep(3000);
    }
  }
}

async function heartbeat(config: RunnerConfig): Promise<void> {
  try {
    await fetch(`${config.backendUrl}/runner/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-device-token": config.deviceToken },
      body: "{}",
    });
  } catch {
    console.warn("[runner] 心跳失败（后台不可达）");
  }
}

async function claim(config: RunnerConfig): Promise<TaskEnvelope | null> {
  const response = await fetch(`${config.backendUrl}/runner/claim`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-device-token": config.deviceToken },
    body: JSON.stringify({ waitMs: 20_000 }),
  });
  if (!response.ok) {
    await sleep(3000);
    return null;
  }
  const data = (await response.json()) as { task: TaskEnvelope | null };
  return data.task ?? null;
}

async function reportResult(
  result: { taskId: string; attemptId: string; outcome: string; externalId?: string | null; url?: string | null; errorCode?: string | null; errorMessage?: string | null; raw?: unknown; finishedAt?: string },
  store: RunnerStore,
  config: RunnerConfig,
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetch(`${config.backendUrl}/runner-results`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-device-token": config.deviceToken },
        body: JSON.stringify(result),
      });
      if (response.ok) {
        store.markReported(result.taskId, result.attemptId);
        console.log(`[runner] 任务 ${result.taskId} 结果已上报：${result.outcome}`);
        return;
      }
    } catch {
      /* 网络失败，重试 */
    }
    await sleep(3000);
  }
  console.error(`[runner] 任务 ${result.taskId} 结果上报失败，保留本地稍后补报`);
}

async function reportPending(store: RunnerStore, config: RunnerConfig): Promise<void> {
  const pending = store.pendingReceipts();
  for (const receipt of pending) {
    console.log(`[runner] 补报历史结果：${receipt.taskId}（${receipt.outcome}）`);
    await reportResult(receipt, store, config);
  }
  // 孤儿提交意图（有 commit_intent 无 receipt）：说明进程在提交前中断，结果未知。
  // 由服务端对账流程处理，这里仅打印提醒。
  for (const intent of store.listOpenIntents()) {
    console.warn(`[runner] 发现未完成提交意图：${intent.taskId}/${intent.attemptId}（服务端将进入 UNKNOWN 对账）`);
  }
}

function readArg(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error("[runner] 启动失败：", error);
  process.exit(1);
});
