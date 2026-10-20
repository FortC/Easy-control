import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { hashPassword, randomId } from "../packages/server-kit/src/index.js";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  try {
    process.loadEnvFile(resolve(rootDir, ".env"));
  } catch {
    /* 使用进程环境变量 */
  }
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const email = "admin@aipeople.dev";
  const existing = await client.query(`SELECT id FROM users WHERE email = $1`, [email]);
  if (existing.rows.length > 0) {
    console.log("种子数据已存在（admin@aipeople.dev），跳过。");
    await client.end();
    return;
  }

  const userId = randomId("user");
  const workspaceId = randomId("ws");
  const now = new Date();

  await client.query("BEGIN");
  try {
    await client.query(`INSERT INTO workspaces (id, name, timezone) VALUES ($1, $2, 'Asia/Shanghai')`, [
      workspaceId,
      "演示工作空间",
    ]);
    await client.query(`INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, $3, $4)`, [
      userId,
      email,
      hashPassword("admin123456"),
      "演示管理员",
    ]);
    await client.query(`INSERT INTO members (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`, [workspaceId, userId]);

    await client.query(
      `INSERT INTO model_providers (id, workspace_id, name, adapter, model, is_default)
       VALUES ($1, $2, '内置 Mock（演示）', 'mock', 'mock', true)`,
      [randomId("mp"), workspaceId],
    );

    const sources: Array<{ kind: string; title: string; content: string; expires?: string }> = [
      {
        kind: "brand",
        title: "品牌介绍：山野茶事",
        content:
          "山野茶事是一家专注高山原叶茶的小型品牌，产地福建宁德海拔 800 米茶园，不使用香精与色素。品牌方提供本资料用于内容创作，授权范围为官方账号发布。",
      },
      {
        kind: "product",
        title: "产品资料：桂花乌龙 100g 罐装",
        content:
          "桂花乌龙 100g 罐装，售价 89 元，采用秋季头采桂花与轻焙乌龙拼配，冷泡热泡均可。保质期 18 个月，生产许可证编号与检测报告见资料附件。",
        expires: nextYear(now),
      },
      {
        kind: "case",
        title: "真实案例：试饮会用户反馈整理",
        content:
          "10 月线下试饮会共 42 人参加，回收问卷 31 份：27 人表示“桂花香气自然”，19 人愿意复购；3 人反馈“希望出小包装”。原始问卷由门店留存，可核对。",
      },
    ];
    for (const source of sources) {
      await client.query(
        `INSERT INTO sources (id, workspace_id, kind, title, content, copyright, license_scope, owner, expires_at, created_by)
         VALUES ($1, $2, $3, $4, $5, '品牌方提供', '官方账号内容创作', '演示管理员', $6, $7)`,
        [randomId("src"), workspaceId, source.kind, source.title, source.content, source.expires ?? null, userId],
      );
    }

    const simulatorAccounts = [
      { platform: "xiaohongshu", uid: "sim_xhs_001", name: "模拟小红书账号", action: "publish_image_note" },
      { platform: "weibo", uid: "sim_wb_001", name: "模拟微博账号", action: "publish_post" },
      { platform: "douyin", uid: "sim_dy_001", name: "模拟抖音账号", action: "publish_video" },
    ];
    for (const account of simulatorAccounts) {
      const accountId = randomId("acct");
      await client.query(
        `INSERT INTO account_connections (id, workspace_id, platform, channel, uid, display_name, capabilities, risk_note)
         VALUES ($1, $2, $3, 'simulator', $4, $5, $6::jsonb, '演示通道，不连接真实平台')`,
        [accountId, workspaceId, account.platform, account.uid, account.name, JSON.stringify([account.action, "pull_metrics"])],
      );
      await client.query(
        `INSERT INTO capability_grants (id, workspace_id, account_id, platform, action, channel, evidence)
         VALUES ($1, $2, $3, $4, $5, 'simulator', 'seed:simulator')`,
        [randomId("grant"), workspaceId, accountId, account.platform, account.action],
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }

  console.log("种子数据完成：");
  console.log("  登录账号：admin@aipeople.dev / admin123456");
  console.log("  工作空间：演示工作空间（3 个模拟平台账号 + 3 份真实资料 + Mock 模型）");
  await client.end();
}

function nextYear(now: Date): string {
  return new Date(now.getTime() + 365 * 86_400_000).toISOString();
}

main().catch((error) => {
  console.error("种子失败：", error);
  process.exit(1);
});
