import pg from "pg";

let pool: pg.Pool | null = null;

export function getDb(connectionString?: string): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: connectionString ?? process.env.DATABASE_URL,
      max: 10,
    });
    // bigint（pg 默认按字符串解析）与 numeric 转换
    pg.types.setTypeParser(pg.types.builtins.INT8, (value) => (value === null ? null : Number(value)));
    pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) => (value === null ? null : Number(value)));
  }
  return pool;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export type DbClient = pg.PoolClient;

export async function withTransaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await getDb().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
