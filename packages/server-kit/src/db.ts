import pg from "pg";

let pool: pg.Pool | null = null;

export function getDb(connectionString?: string): pg.Pool {
  if (!pool) {
    if (process.env.EASYCONTROL_DATABASE_PATH) {
      pool = createEmbeddedPool() as unknown as pg.Pool;
      return pool;
    }
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

/** 单用户桌面使用进程内 PostgreSQL/WASM；事务持有互斥锁，避免并行请求串入同一事务。 */
function createEmbeddedPool() {
  let instance: Promise<any> | null = null;
  let tail: Promise<void> = Promise.resolve();
  async function database() {
    if (!instance) instance = (async () => {
      const entry = process.env.EASYCONTROL_PGLITE_ENTRY || '@electric-sql/pglite';
      const { PGlite } = await import(entry);
      return PGlite.create(process.env.EASYCONTROL_DATABASE_PATH, { parsers: { 20: Number, 1700: Number } });
    })();
    return instance;
  }
  async function acquire() {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    return release;
  }
  async function query(text: string, params?: unknown[]) {
    const db = await database();
    const result = params?.length ? await db.query(text, params) : (await db.exec(text)).at(-1) || { rows: [], affectedRows: 0 };
    return { ...result, rows: result.rows || [], rowCount: result.affectedRows ?? result.rows?.length ?? 0 };
  }
  return {
    async query(text: string, params?: unknown[]) { const unlock = await acquire(); try { return await query(text, params); } finally { unlock(); } },
    async connect() {
      const unlock = await acquire(); let released = false; let transaction = false;
      return {
        async query(text: string, params?: unknown[]) {
          if (released) throw new Error('数据库连接已释放');
          const result = await query(text, params);
          if (/^\s*BEGIN/i.test(text)) transaction = true;
          if (/^\s*(?:COMMIT|ROLLBACK)/i.test(text)) transaction = false;
          return result;
        },
        release() { if (!released) { released = true; if (transaction) void query('ROLLBACK').finally(unlock); else unlock(); } },
      };
    },
    async end() { const unlock = await acquire(); try { if (instance) await (await instance).close(); } finally { unlock(); } },
  };
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
