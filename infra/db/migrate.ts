import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function main() {
  try {
    process.loadEnvFile(join(rootDir, ".env"));
  } catch {
    /* 使用进程环境变量 */
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("缺少 DATABASE_URL（参考 .env.example）");
    process.exit(1);
  }
  const client = new pg.Client({ connectionString });
  await client.connect();

  await client.query(`CREATE TABLE IF NOT EXISTS applied_migrations (
    filename text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);

  const migrationsDir = join(rootDir, "infra/db/migrations");
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  const applied = new Set(
    (await client.query<{ filename: string }>("SELECT filename FROM applied_migrations")).rows.map((r) => r.filename),
  );

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(migrationsDir, file), "utf8");
    console.log(`应用迁移 ${file} …`);
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO applied_migrations (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
      count += 1;
    } catch (error) {
      await client.query("ROLLBACK");
      console.error(`迁移 ${file} 失败：`, error instanceof Error ? error.message : error);
      process.exit(1);
    }
  }
  console.log(`迁移完成：本次应用 ${count} 个，共 ${files.length} 个文件。`);
  await client.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
