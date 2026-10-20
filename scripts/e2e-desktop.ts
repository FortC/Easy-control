/**
 * 桌面端 GUI 端到端测试：直接驱动打包产物（win-unpacked/AIPeople.exe），
 * 验证免登录个人模式——启动即连接后台并渲染工作台，巡检各页面。
 *
 * 前置：后端已运行（pnpm dev 或 api+worker），桌面端已打包。
 * 运行：npx tsx scripts/e2e-desktop.ts [可选 exe 路径]
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { _electron, type ElectronApplication, type Page } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultExe = resolve(root, "apps/desktop/release/win-unpacked/AIPeople.exe");
const exePath = process.argv[2] ?? defaultExe;
const userDataDir = mkdtempSync(resolve(tmpdir(), "aipeople-e2e-"));

let failures = 0;
function ok(name: string, passed: boolean, detail?: unknown): void {
  if (passed) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error(`  ✗ ${name}`, detail ?? "");
  }
}

async function main(): Promise<void> {
  console.log(`=== 桌面端 GUI 测试（免登录个人模式） ===\n目标：${exePath}`);

  const app: ElectronApplication = await _electron.launch({
    executablePath: exePath,
    args: [`--user-data-dir=${userDataDir}`],
    timeout: 30_000,
  });

  const page: Page = await app.firstWindow();
  page.on("pageerror", (error) => {
    console.error("  [渲染进程异常]", error.message);
    failures += 1;
  });
  page.on("console", (message) => {
    if (message.type() === "error") console.error("  [console.error]", message.text().slice(0, 300));
  });
  page.on("requestfailed", (request) => {
    console.error("  [请求失败]", request.url().slice(0, 160), request.failure()?.errorText ?? "");
  });
  page.on("response", (response) => {
    if (response.url().includes(":8787") && response.request().method() !== "GET") {
      console.log(`  [API] ${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`);
    }
  });

  async function dumpState(tag: string): Promise<void> {
    const shot = resolve(root, `.local/e2e-fail-${tag}.png`);
    await page.screenshot({ path: shot }).catch(() => {});
    const text = await page.locator("body").innerText().catch(() => "(无法读取)");
    console.error(`  [状态转储:${tag}] 截图 ${shot}\n  页面文本: ${text.replace(/\s+/g, " ").slice(0, 400)}`);
  }

  // 1) 启动：自动连接后台，直达工作台（侧边栏出现 = 渲染层加载 + 免登录均成功）
  try {
    await page.locator("text=内容工作台").first().waitFor({ timeout: 30_000 });
    ok("启动后自动进入工作台（免登录）", true);
  } catch {
    await dumpState("bootstrap");
    throw new Error("启动后未见工作台");
  }
  ok("渲染层无加载失败弹窗", (await page.locator("text=界面加载失败").count()) === 0);
  ok("无残留登录/连接错误页", (await page.locator("text=无法连接后台服务").count()) === 0);

  // 2) 总览统计渲染
  try {
    await page.locator("text=今日任务").first().waitFor({ timeout: 15_000 });
    ok("总览页统计卡渲染", true);
  } catch {
    await dumpState("overview");
    ok("总览页统计卡渲染", false);
  }
  await page.screenshot({ path: resolve(root, ".local/e2e-main.png") });

  // 3) 巡检关键页面可打开
  for (const nav of ["账号中心", "内容工作台", "任务与日历", "结果与数据", "异常处理", "资料与素材", "助手与模型"]) {
    try {
      await page.locator(`a:has-text("${nav}")`).first().click();
      await page.waitForTimeout(700);
      ok(`页面可打开：${nav}`, true);
    } catch {
      await dumpState(`nav-${nav}`);
      ok(`页面可打开：${nav}`, false);
    }
  }

  // 4) 内容工作台页面核心控件存在
  await page.locator(`a:has-text("内容工作台")`).first().click();
  try {
    await page.locator('input[placeholder*="例如"]').waitFor({ timeout: 10_000 });
    ok("内容工作台表单可交互", true);
  } catch {
    await dumpState("studio");
    ok("内容工作台表单可交互", false);
  }

  await page.screenshot({ path: resolve(root, ".local/e2e-studio.png") });
  await app.close();
  console.log(`\n=== 结果：${failures === 0 ? "全部通过" : `${failures} 项失败`} ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("GUI 测试异常：", error);
  process.exit(1);
});
