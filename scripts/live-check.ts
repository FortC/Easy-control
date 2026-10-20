import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "http://localhost:8787";
let token = "";
async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json)}`);
  return json;
}
const login = await call("POST", "/auth/login", { email: "admin@aipeople.dev", password: "admin123456" });
token = login.token;
const accounts = await call("GET", "/accounts");
const xhs = accounts.accounts.find((a: any) => a.platform === "xiaohongshu" && a.channel === "simulator");
const prepare = await call("POST", "/contents/prepare", {
  goal: "为真实进程链路验证准备一篇桂花乌龙种草笔记",
  targets: [{ platform: "xiaohongshu", accountId: xhs.id }],
});
const cv = prepare.versions[0].id;
await call("POST", `/contents/${cv}/ready-for-review`);
const approve = await call("POST", `/content-versions/${cv}/approve`, { accountId: xhs.id, action: "publish_image_note", validMinutes: 120 });
const at = new Date(Date.now() + 75_000).toISOString();
const schedule = await call("POST", "/schedules", {
  mode: "single", contentVersionId: cv, approvalId: approve.approvalId, accountId: xhs.id,
  platform: "xiaohongshu", action: "publish_image_note", at,
});
console.log(`任务 ${schedule.taskId} 将于 ${at} 执行`);
const deadline = Date.now() + 4 * 60_000;
let last = "";
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 4000));
  const task = await call("GET", `/tasks/${schedule.taskId}`);
  if (task.task.status !== last) {
    last = task.task.status;
    console.log(`  状态: ${last}  公开: ${task.publication?.publication_status ?? "—"}  ${new Date().toLocaleTimeString("zh-CN")}`);
  }
  if (["PUBLISHED", "FAILED", "NEEDS_HUMAN", "MISSED", "CANCELLED", "UNKNOWN"].includes(last)) {
    console.log(`最终: ${last} url=${task.publication?.url ?? "无"}`);
    process.exit(last === "PUBLISHED" ? 0 : 1);
  }
}
console.log("超时未达终态");
process.exit(1);
