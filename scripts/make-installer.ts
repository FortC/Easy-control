/**
 * 一条命令产出「验证过的」Windows 安装包（持续迭代的标准发布流程）：
 *
 *   pnpm release
 *
 * 流程：确保 PostgreSQL → 迁移 → 确保后台在线（复用或启动 api+worker）
 *   → 类型检查 → 单元测试 → 冒烟测试 → 图标 → 渲染层构建 → electron-builder 打包
 *   → 对打包产物做 GUI 端到端实测 → 报告产物路径。
 *
 * 任一步失败立即终止（保留现场），全部通过才认为安装包可交付。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = resolve(root, "node_modules/tsx/dist/cli.mjs");
const exePath = resolve(root, "apps/desktop/release/win-unpacked/AIPeople.exe");
const installerPath = resolve(root, "apps/desktop/release");

try {
  process.loadEnvFile(resolve(root, ".env"));
} catch {
  /* 使用进程环境变量 */
}

const apiPort = process.env.API_PORT ?? "8787";
const apiBase = `http://localhost:${apiPort}`;
const spawned: ChildProcess[] = [];

function run(name: string, command: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    console.log(`\n▶ ${name}\n  $ ${command} ${args.join(" ")}`);
    const child = spawn(command, args, {
      cwd: opts.cwd ?? root,
      stdio: "inherit",
      shell: false,
      windowsHide: true,
    });
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill();
          rejectPromise(new Error(`${name} 超时（${opts.timeoutMs}ms）`));
        }, opts.timeoutMs)
      : null;
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      rejectPromise(new Error(`${name} 启动失败：${error.message}`));
    });
    child.on("exit", (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${name} 失败（退出码 ${code}）`));
    });
  });
}

async function waitForApi(timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${apiBase}/health`);
      if (response.ok) return true;
    } catch {
      /* 未就绪 */
    }
    await sleep(1500);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function stopSpawned(): Promise<void> {
  for (const child of spawned) {
    if (child.pid && !child.killed) {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    }
  }
}

async function main(): Promise<void> {
  console.log("=== AI People 安装包发布流水线 ===");

  // 1) PostgreSQL
  console.log("\n▶ 检查 PostgreSQL（docker compose）");
  const dbReady = await new Promise<boolean>((resolvePromise) => {
    const probe = spawn("docker", ["compose", "ps", "--status", "running", "--services"], { cwd: root, stdio: "pipe", shell: false, windowsHide: true });
    let out = "";
    probe.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString()));
    probe.on("error", () => resolvePromise(false));
    probe.on("exit", () => resolvePromise(out.includes("postgres")));
  });
  if (!dbReady) {
    await run("启动 PostgreSQL", "docker", ["compose", "up", "-d"]);
    console.log("  等待数据库就绪…");
    await sleep(6000);
  } else {
    console.log("  PostgreSQL 已在运行");
  }

  // 2) 迁移（幂等）
  await run("数据库迁移", process.execPath, [tsxCli, "infra/db/migrate.ts"], { timeoutMs: 120_000 });

  // 3) 后台在线：复用或启动 api + worker
  const apiHealthy = await waitForApi(3000);
  if (apiHealthy) {
    console.log("\n▶ 后台已在运行，直接复用");
  } else {
    console.log("\n▶ 启动后台服务（api + worker）");
    spawned.push(spawn(process.execPath, [tsxCli, "apps/api/src/main.ts"], { cwd: root, stdio: "ignore", windowsHide: true, detached: true }));
    spawned.push(spawn(process.execPath, [tsxCli, "apps/worker/src/main.ts"], { cwd: root, stdio: "ignore", windowsHide: true, detached: true }));
    if (!(await waitForApi(60_000))) {
      await stopSpawned();
      throw new Error("后台 API 启动超时");
    }
    console.log("  后台已就绪（发布完成后保持运行，可直接打开工作台使用）");
  }

  // 4) 全量测试
  await run("类型检查", process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit", "-p", "tsconfig.json"], { timeoutMs: 300_000 });
  await run("单元测试", process.execPath, [tsxCli, "node_modules/vitest/vitest.mjs", "run"], { timeoutMs: 300_000 });
  await run("端到端冒烟测试", process.execPath, [tsxCli, "scripts/smoke.ts"], { timeoutMs: 300_000 });

  // 5) 构建
  await run("渲染层构建", process.execPath, [tsxCli, "node_modules/vite/bin/vite.js", "build"], {
    cwd: resolve(root, "apps/desktop"),
    timeoutMs: 300_000,
  });

  // 6) 打包
  process.env.ELECTRON_MIRROR ??= "https://npmmirror.com/mirrors/electron/";
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR ??= "https://npmmirror.com/mirrors/electron-builder-binaries/";
  await run("electron-builder 打包", process.execPath, [tsxCli, "node_modules/electron-builder/cli.js", "--win", "nsis", "--config", "electron-builder.yml"], {
    cwd: resolve(root, "apps/desktop"),
    timeoutMs: 600_000,
  });
  if (!existsSync(exePath)) throw new Error("打包产物缺失：win-unpacked/AIPeople.exe");

  // 7) 打包产物 GUI 实测（最后一道关口）
  await run("打包产物 GUI 实测", process.execPath, [tsxCli, "scripts/e2e-desktop.ts", exePath], { timeoutMs: 300_000 });

  console.log("\n=== ✅ 安装包发布完成 ===");
  console.log(`  安装程序：${resolve(root, "apps/desktop/release/AIPeople Setup 0.3.0.exe").replace(/ 0\.3\.0/, ` ${await readVersion()}`)}`);
  console.log(`  免安装版：${exePath}`);
  console.log("  后台服务保持运行中；重启电脑后：pnpm db:up && pnpm release（或 pnpm dev）");
  process.exit(0);
}

async function readVersion(): Promise<string> {
  const pkg = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(resolve(root, "apps/desktop/package.json"), "utf8")));
  return String((pkg as { version: string }).version ?? "");
}

main().catch(async (error) => {
  console.error(`\n=== ❌ 发布失败：${error instanceof Error ? error.message : error} ===`);
  if (spawned.length > 0) {
    console.error("（本次启动的后台服务已停止；修复问题后重新运行 pnpm release）");
    await stopSpawned();
  }
  process.exit(1);
});
