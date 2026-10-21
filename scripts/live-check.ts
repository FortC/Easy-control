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
const schedule = await fetch(`${BASE}/schedules`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({
  mode: "single", contentVersionId: cv, approvalId: approve.approvalId, accountId: xhs.id,
  platform: "xiaohongshu", action: "publish_image_note", at,
  }),
});
if (schedule.status !== 400) throw new Error("小红书真人交付边界失效：自动排程应被拒绝");
console.log("✓ 小红书内容草稿可生成；自动排程按真人交付边界被拒绝");
process.exit(0);

export {};
