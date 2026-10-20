import type { DbClient } from "@aipeople/server-kit";
import type { EventType } from "@aipeople/contracts";

export interface RecordEventInput {
  workspaceId: string;
  taskId?: string | null;
  accountId?: string | null;
  type: EventType;
  payload: Record<string, unknown>;
  /** 幂等键：重复投递去重（方案 §4.2）。 */
  dedupeKey?: string | null;
}

/** 写入事件流（UI 通过 GET /task-events?after= 增量拉取）。忽略唯一键冲突。 */
export async function recordEvent(client: DbClient, input: RecordEventInput): Promise<void> {
  await client.query(
    `INSERT INTO events (workspace_id, task_id, account_id, type, payload, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [input.workspaceId, input.taskId ?? null, input.accountId ?? null, input.type, JSON.stringify(input.payload), input.dedupeKey ?? null],
  );
}

/** 写入 outbox（业务事务内调用，由 Worker 分发器投递）。 */
export async function insertOutbox(
  client: DbClient,
  workspaceId: string,
  kind: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(`INSERT INTO outbox (workspace_id, kind, payload) VALUES ($1, $2, $3)`, [
    workspaceId,
    kind,
    JSON.stringify(payload),
  ]);
}
