import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ReceiptRecord {
  taskId: string;
  attemptId: string;
  outcome: string;
  externalId: string | null;
  url: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  raw: unknown;
  finishedAt: string;
  reportedAt: string | null;
}

export interface JournalRecord {
  taskId: string;
  attemptId: string;
  /** claim / commit_intent / done */
  phase: string;
  createdAt: string;
  detail?: Record<string, unknown>;
}

export interface RunnerConfig {
  backendUrl: string;
  runnerId: string;
  deviceToken: string;
  workspaceId: string;
  name: string;
}

/**
 * 本地收据与提交意图存储（方案 §4.3：SQLite 收据、断网先落盘、恢复后补报）。
 * 优先使用 node:sqlite；环境不可用时回退 JSON 文件（原子写）。
 */
export interface RunnerStore {
  saveConfig(config: RunnerConfig): void;
  loadConfig(): RunnerConfig | null;
  writeJournal(entry: JournalRecord): void;
  listOpenIntents(): JournalRecord[];
  clearJournal(taskId: string, attemptId: string): void;
  saveReceipt(record: ReceiptRecord): void;
  pendingReceipts(): ReceiptRecord[];
  markReported(taskId: string, attemptId: string): void;
}

export function openStore(dataDir: string): RunnerStore {
  mkdirSync(dataDir, { recursive: true });
  try {
    return new SqliteStore(join(dataDir, "runner.db"));
  } catch {
    console.warn("[runner] node:sqlite 不可用，回退 JSON 存储");
    return new JsonStore(join(dataDir, "runner-store.json"));
  }
}

class SqliteStore implements RunnerStore {
  private db: import("node:sqlite").DatabaseSync;

  constructor(file: string) {
    const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite") | undefined;
    if (!sqlite) throw new Error("node:sqlite 不可用");
    this.db = new sqlite.DatabaseSync(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS journal (
        task_id TEXT NOT NULL, attempt_id TEXT NOT NULL, phase TEXT NOT NULL,
        created_at TEXT NOT NULL, detail TEXT,
        PRIMARY KEY (task_id, attempt_id, phase)
      );
      CREATE TABLE IF NOT EXISTS receipts (
        task_id TEXT NOT NULL, attempt_id TEXT NOT NULL, outcome TEXT NOT NULL,
        external_id TEXT, url TEXT, error_code TEXT, error_message TEXT,
        raw TEXT, finished_at TEXT NOT NULL, reported_at TEXT,
        PRIMARY KEY (task_id, attempt_id)
      );
    `);
  }

  saveConfig(config: RunnerConfig): void {
    this.db
      .prepare("INSERT INTO kv (key, value) VALUES ('config', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(config));
  }

  loadConfig(): RunnerConfig | null {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = 'config'").get() as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as RunnerConfig) : null;
  }

  writeJournal(entry: JournalRecord): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO journal (task_id, attempt_id, phase, created_at, detail) VALUES (?, ?, ?, ?, ?)",
      )
      .run(entry.taskId, entry.attemptId, entry.phase, entry.createdAt, entry.detail ? JSON.stringify(entry.detail) : null);
  }

  listOpenIntents(): JournalRecord[] {
    const rows = this.db
      .prepare("SELECT task_id, attempt_id, phase, created_at, detail FROM journal WHERE phase = 'commit_intent'")
      .all() as Array<{ task_id: string; attempt_id: string; phase: string; created_at: string; detail: string | null }>;
    return rows.map((row) => ({
      taskId: row.task_id,
      attemptId: row.attempt_id,
      phase: row.phase,
      createdAt: row.created_at,
      detail: row.detail ? JSON.parse(row.detail) : undefined,
    }));
  }

  clearJournal(taskId: string, attemptId: string): void {
    this.db.prepare("DELETE FROM journal WHERE task_id = ? AND attempt_id = ?").run(taskId, attemptId);
  }

  saveReceipt(record: ReceiptRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO receipts (task_id, attempt_id, outcome, external_id, url, error_code, error_message, raw, finished_at, reported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.taskId,
        record.attemptId,
        record.outcome,
        record.externalId,
        record.url,
        record.errorCode,
        record.errorMessage,
        JSON.stringify(record.raw ?? null),
        record.finishedAt,
        record.reportedAt,
      );
  }

  pendingReceipts(): ReceiptRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM receipts WHERE reported_at IS NULL")
      .all() as Array<Record<string, string | null>>;
    return rows.map((row) => ({
      taskId: row.task_id!,
      attemptId: row.attempt_id!,
      outcome: row.outcome!,
      externalId: row.external_id,
      url: row.url,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      raw: row.raw ? JSON.parse(row.raw) : null,
      finishedAt: row.finished_at!,
      reportedAt: null,
    }));
  }

  markReported(taskId: string, attemptId: string): void {
    this.db
      .prepare("UPDATE receipts SET reported_at = ? WHERE task_id = ? AND attempt_id = ?")
      .run(new Date().toISOString(), taskId, attemptId);
  }
}

interface JsonState {
  config: RunnerConfig | null;
  journal: JournalRecord[];
  receipts: ReceiptRecord[];
}

class JsonStore implements RunnerStore {
  private file: string;
  private state: JsonState;

  constructor(file: string) {
    this.file = file;
    this.state = existsSync(file)
      ? (JSON.parse(readFileSync(file, "utf8")) as JsonState)
      : { config: null, journal: [], receipts: [] };
  }

  private flush(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state), "utf8");
    renameSync(tmp, this.file);
  }

  saveConfig(config: RunnerConfig): void {
    this.state.config = config;
    this.flush();
  }

  loadConfig(): RunnerConfig | null {
    return this.state.config;
  }

  writeJournal(entry: JournalRecord): void {
    this.state.journal = this.state.journal.filter(
      (j) => !(j.taskId === entry.taskId && j.attemptId === entry.attemptId && j.phase === entry.phase),
    );
    this.state.journal.push(entry);
    this.flush();
  }

  listOpenIntents(): JournalRecord[] {
    return this.state.journal.filter((j) => j.phase === "commit_intent");
  }

  clearJournal(taskId: string, attemptId: string): void {
    this.state.journal = this.state.journal.filter((j) => !(j.taskId === taskId && j.attemptId === attemptId));
    this.flush();
  }

  saveReceipt(record: ReceiptRecord): void {
    this.state.receipts = this.state.receipts.filter((r) => !(r.taskId === record.taskId && r.attemptId === record.attemptId));
    this.state.receipts.push(record);
    this.flush();
  }

  pendingReceipts(): ReceiptRecord[] {
    return this.state.receipts.filter((r) => r.reportedAt === null);
  }

  markReported(taskId: string, attemptId: string): void {
    for (const r of this.state.receipts) {
      if (r.taskId === taskId && r.attemptId === attemptId) r.reportedAt = new Date().toISOString();
    }
    this.flush();
  }
}

export function ensureDirFor(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
}
