/**
 * 端到端冒烟测试（无需真实平台凭据）：
 * 注册 → 连接模拟账号 → 上传资料 → 生成草稿 → 送审/审批 → 排程 → 发放 → Runner 执行
 * → 模拟平台审核 → PUBLISHED；并注入「验证码」场景断言 NEEDS_HUMAN + 账号暂停。
 *
 * 运行：先 db:migrate，然后 pnpm smoke
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
try {
  process.loadEnvFile(resolve(rootDir, ".env"));
} catch {
  /* 使用进程环境变量 */
}

const { buildServer } = await import("../apps/api/src/server.js");
const orchestration = await import("../packages/orchestration/src/index.js");
const runnerStorage = await import("../apps/runner/src/storage.js");
const runnerExecutor = await import("../apps/runner/src/executor.js");

const runId = Date.now().toString(36);
let passed = 0;
let failed = 0;

function ok(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}`, detail ?? "");
  }
}

async function waitFor(name: string, fn: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(500);
  }
  console.error(`  ✗ 等待超时：${name}`);
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Api {
  baseUrl: string;
  token: string | null;
}

async function apiCall(api: Api, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${api.baseUrl}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(api.token ? { authorization: `Bearer ${api.token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => null);
  return { status: response.status, json };
}

async function main() {
  console.log(`=== AI People 冒烟测试 ${runId} ===`);

  // 0) 启动 API（随机端口）
  const server = await buildServer();
  await server.listen({ port: 0, host: "127.0.0.1" });
  const address = server.addresses()[0];
  const baseUrl = `http://127.0.0.1:${address.port}`;
  console.log(`API 已启动：${baseUrl}`);

  // 后台循环（模拟 Worker 的 tick）
  const tick = setInterval(() => {
    void orchestration.releaseDueTasks().catch(() => {});
    void orchestration.advanceSimulatorReview().catch(() => {});
    void orchestration.sweepStaleWaitingTasks().catch(() => {});
  }, 1000);
  tick.unref();

  try {
    // 1) 注册与登录
    const anon: Api = { baseUrl, token: null };
    const register = await apiCall(anon, "POST", "/auth/register", {
      email: `smoke-${runId}@aipeople.dev`,
      password: "smoke-password-123",
      displayName: "冒烟测试",
      workspaceName: `冒烟空间 ${runId}`,
    });
    ok("注册工作空间", register.status === 201, register.json);
    const api: Api = { baseUrl, token: register.json.token };

    // 2) 连接模拟账号
    const account = await apiCall(api, "POST", "/accounts", {
      platform: "xiaohongshu",
      channel: "simulator",
      displayName: "冒烟小红书号",
    });
    ok("连接模拟小红书账号", account.status === 201, account.json);
    const accountId = account.json.id;

    // 3) 上传资料
    const source = await apiCall(api, "POST", "/sources", {
      kind: "product",
      title: "冒烟产品资料",
      content: "冒烟测试产品：高山原叶茶，售价 89 元，产地宁德，检测报告可查。该资料仅用于测试。",
    });
    ok("上传资料", source.status === 201, source.json);

    // 4) 生成草稿（Mock 供应商）
    const prepare = await apiCall(api, "POST", "/contents/prepare", {
      goal: `介绍冒烟测试产品并引导互动（${runId}）`,
      targets: [{ platform: "xiaohongshu", accountId }],
      sourceIds: [source.json.id],
    });
    ok("生成平台草稿", prepare.status === 201 && prepare.json.versions.length === 1, prepare.json);
    const contentId = prepare.json.versions[0].id;

    const contentDetail = await apiCall(api, "GET", `/contents/${contentId}`);
    ok("草稿包含事实引用", contentDetail.json.content.citations.length >= 1, contentDetail.json.content?.citations);
    ok("草稿包含 AI 声明", contentDetail.json.content.declarations.aiGenerated === true);

    // 5) 送审 + 审批
    ok("送审", (await apiCall(api, "POST", `/contents/${contentId}/ready-for-review`)).status === 200);
    const approve = await apiCall(api, "POST", `/content-versions/${contentId}/approve`, {
      accountId,
      action: "publish_image_note",
      validMinutes: 60,
    });
    ok("审批通过", approve.status === 200 && approve.json.approvalId, approve.json);
    const approvalId = approve.json.approvalId;

    // 审批后修改内容 → 旧审批失效
    const edit = await apiCall(api, "PUT", `/contents/${contentId}`, {
      title: "冒烟修改后的标题",
      body: "内容被修改，审批应当失效。",
      topics: [],
      declarations: { aiGenerated: true, commercial: false },
    });
    ok("审批后修改内容", edit.status === 200);
    const staleSchedule = await apiCall(api, "POST", "/schedules", {
      mode: "single",
      contentVersionId: contentId,
      approvalId,
      accountId,
      platform: "xiaohongshu",
      action: "publish_image_note",
      at: new Date(Date.now() + 10_000).toISOString(),
    });
    ok("旧审批排程被拒绝", staleSchedule.status === 400, staleSchedule.json);

    // 重新送审审批（走完整流程）
    await apiCall(api, "POST", `/contents/${contentId}/ready-for-review`);
    const approve2 = await apiCall(api, "POST", `/content-versions/${contentId}/approve`, {
      accountId,
      action: "publish_image_note",
      validMinutes: 60,
    });
    const approval2 = approve2.json.approvalId;
    ok("重新审批", Boolean(approval2));

    // 6) Runner 配对
    const pairCode = await apiCall(api, "POST", "/runners/pairing-codes");
    ok("生成配对码", pairCode.status === 200, pairCode.json);
    const pair = await apiCall(anon, "POST", "/runners/pair", { code: pairCode.json.code, name: `冒烟设备 ${runId}` });
    ok("设备配对", pair.status === 200 && pair.json.deviceToken, pair.json);

    const storeDir = mkdtempSync(resolve(tmpdir(), `aipeople-smoke-${runId}-`));
    const store = runnerStorage.openStore(storeDir);
    const runnerConfig = {
      backendUrl: baseUrl,
      runnerId: pair.json.runnerId,
      deviceToken: pair.json.deviceToken,
      workspaceId: pair.json.workspaceId,
      name: `冒烟设备 ${runId}`,
    };
    store.saveConfig(runnerConfig);

    // 7) 排程（10 秒后）
    const scheduleAt = new Date(Date.now() + 10_000);
    const schedule = await apiCall(api, "POST", "/schedules", {
      mode: "single",
      contentVersionId: contentId,
      approvalId: approval2,
      accountId,
      platform: "xiaohongshu",
      action: "publish_image_note",
      at: scheduleAt.toISOString(),
    });
    ok("创建排程", schedule.status === 201 && schedule.json.taskId, schedule.json);
    const taskId = schedule.json.taskId;

    // 8) Runner 循环（领取 → 执行 → 上报）
    const runnerLoop = setInterval(() => {
      void (async () => {
        const claimResponse = await fetch(`${baseUrl}/runner/claim`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-device-token": runnerConfig.deviceToken },
          body: JSON.stringify({ waitMs: 0 }),
        });
        if (!claimResponse.ok) return;
        const data = (await claimResponse.json()) as { task: any };
        if (!data.task) return;
        console.log(`  Runner 领取任务 ${data.task.taskId}`);
        const result = await runnerExecutor.executeEnvelope(data.task, runnerConfig, store, storeDir);
        await fetch(`${baseUrl}/runner-results`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-device-token": runnerConfig.deviceToken },
          body: JSON.stringify(result),
        });
        // 重复上报一次验证幂等
        await fetch(`${baseUrl}/runner-results`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-device-token": runnerConfig.deviceToken },
          body: JSON.stringify(result),
        });
      })().catch(() => {});
    }, 1000);
    runnerLoop.unref();

    const publishedInTime = await waitFor(
      "任务 PUBLISHED",
      async () => {
        const task = await apiCall(api, "GET", `/tasks/${taskId}`);
        return task.json.task?.status === "PUBLISHED";
      },
      60_000,
    );
    ok("端到端发布闭环（SCHEDULED→…→PUBLISHED）", publishedInTime);

    const finalTask = await apiCall(api, "GET", `/tasks/${taskId}`);
    ok("发布状态确认为已公开", finalTask.json.publication?.publication_status === "published", finalTask.json.publication);
    ok("返回平台链接", typeof finalTask.json.publication?.url === "string" && finalTask.json.publication.url.length > 0);
    ok("事件流非空", (finalTask.json.events?.length ?? 0) >= 3, finalTask.json.events?.length);

    const events = await apiCall(api, "GET", "/task-events?after=0&limit=500");
    ok("工作空间事件流", (events.json.events?.length ?? 0) >= 5, events.json.events?.length);

    // 9) 验证码场景：注入 scenario=captcha
    const captchaAccount = await apiCall(api, "POST", "/accounts", {
      platform: "weibo",
      channel: "simulator",
      displayName: "冒烟微博号（验证码场景）",
    });
    const wbAccountId = captchaAccount.json.id;
    const wbPrepare = await apiCall(api, "POST", "/contents/prepare", {
      goal: `验证码场景 ${runId}`,
      targets: [{ platform: "weibo", accountId: wbAccountId }],
    });
    const wbContentId = wbPrepare.json.versions[0].id;
    await apiCall(api, "POST", `/contents/${wbContentId}/ready-for-review`);
    const wbApprove = await apiCall(api, "POST", `/content-versions/${wbContentId}/approve`, {
      accountId: wbAccountId,
      action: "publish_post",
      validMinutes: 30,
    });
    const wbSchedule = await apiCall(api, "POST", "/schedules", {
      mode: "single",
      contentVersionId: wbContentId,
      approvalId: wbApprove.json.approvalId,
      accountId: wbAccountId,
      platform: "weibo",
      action: "publish_post",
      at: new Date(Date.now() + 5000).toISOString(),
    });
    const wbTaskId = wbSchedule.json.taskId;
    // 直接注入模拟场景（生产中由平台触发）
    const { getDb } = await import("../packages/server-kit/src/index.js");
    await getDb().query(`UPDATE tasks SET scenario = 'captcha' WHERE id = $1`, [wbTaskId]);
    ok("注入验证码场景", Boolean(wbTaskId));

    const captchaHandled = await waitFor(
      "验证码任务 NEEDS_HUMAN",
      async () => {
        const task = await apiCall(api, "GET", `/tasks/${wbTaskId}`);
        return task.json.task?.status === "NEEDS_HUMAN";
      },
      45_000,
    );
    ok("平台拦截转 NEEDS_HUMAN", captchaHandled);

    const accountsAfter = await apiCall(api, "GET", "/accounts");
    const wbAccountAfter = accountsAfter.json.accounts.find((a: any) => a.id === wbAccountId);
    ok("账号被暂停外发", wbAccountAfter?.paused === true, wbAccountAfter);

    const incidents = await apiCall(api, "GET", "/incidents?status=open");
    ok("异常登记打开", incidents.json.incidents.length >= 1, incidents.json.incidents?.length);

    // 10) 总览
    const overview = await apiCall(api, "GET", "/overview");
    ok("总览数据", typeof overview.json.todayTasks === "number" && overview.json.runners.length === 1, overview.json);
  } finally {
    clearInterval(tick);
    await server.close();
  }

  console.log(`\n=== 结果：${passed} 通过，${failed} 失败 ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("冒烟测试异常：", error);
  process.exit(1);
});
