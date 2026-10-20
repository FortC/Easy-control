import { randomId, type DbClient } from "@aipeople/server-kit";
import { assertTransition, type TaskState } from "@aipeople/contracts";
import { recordEvent } from "./events.js";

export interface TaskRow {
  id: string;
  workspace_id: string;
  schedule_id: string | null;
  occurrence_at: Date;
  platform: string;
  channel: string;
  account_id: string;
  action: string;
  content_version_id: string;
  approval_id: string;
  content_hash: string;
  status: TaskState;
  runner_id: string | null;
  execution_window_start: Date | null;
  execution_window_end: Date | null;
  idempotency_key: string;
  scenario: string | null;
  last_error: unknown;
  attempts: number;
  created_at: Date;
  updated_at: Date;
}

export async function getTask(client: DbClient, workspaceId: string, taskId: string): Promise<TaskRow | null> {
  const result = await client.query<TaskRow>(
    `SELECT * FROM tasks WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, taskId],
  );
  return result.rows[0] ?? null;
}

/**
 * 状态迁移：校验合法迁移并写事件。并发安全由调用方的事务保证
 * （UPDATE ... WHERE status = 期望值 的乐观检查）。
 */
export async function transitionTaskState(
  client: DbClient,
  workspaceId: string,
  taskId: string,
  from: TaskState,
  to: TaskState,
  extra: { lastError?: { code: string; message: string } | null; runnerId?: string | null } = {},
): Promise<boolean> {
  assertTransition(from, to);
  const result = await client.query(
    `UPDATE tasks SET status = $4, updated_at = now(),
       last_error = COALESCE($5::jsonb, last_error),
       runner_id = COALESCE($6::text, runner_id)
     WHERE workspace_id = $1 AND id = $2 AND status = $3
     RETURNING id`,
    [workspaceId, taskId, from, to, extra.lastError ? JSON.stringify(extra.lastError) : null, extra.runnerId ?? null],
  );
  if (result.rowCount === 0) return false;
  await recordEvent(client, {
    workspaceId,
    taskId,
    type: "task.state_changed",
    payload: { from, to, error: extra.lastError ?? null },
    dedupeKey: `state:${taskId}:${from}:${to}:${Date.now()}`,
  });
  if (to === "NEEDS_HUMAN") {
    await recordEvent(client, {
      workspaceId,
      taskId,
      type: "task.needs_human",
      payload: { error: extra.lastError ?? null },
      dedupeKey: `needs_human:${taskId}:${Date.now()}`,
    });
  }
  return true;
}

/** 打开异常登记（同一任务+类型只保留一条未处理的）。 */
export async function openIncident(
  client: DbClient,
  input: { workspaceId: string; accountId?: string | null; taskId?: string | null; kind: string; detail: Record<string, unknown> },
): Promise<void> {
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM incidents WHERE workspace_id = $1 AND task_id IS NOT DISTINCT FROM $2 AND kind = $3 AND status = 'open' LIMIT 1`,
    [input.workspaceId, input.taskId ?? null, input.kind],
  );
  if (existing.rows.length > 0) return;
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO incidents (id, workspace_id, account_id, task_id, kind, detail) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [randomId("inc"), input.workspaceId, input.accountId ?? null, input.taskId ?? null, input.kind, JSON.stringify(input.detail)],
  );
  await recordEvent(client, {
    workspaceId: input.workspaceId,
    taskId: input.taskId ?? null,
    accountId: input.accountId ?? null,
    type: "incident.opened",
    payload: { incidentId: inserted.rows[0]!.id, kind: input.kind, ...input.detail },
  });
}

/** 暂停账号外发（验证码/会话失效等），写事件与异常。 */
export async function pauseAccount(
  client: DbClient,
  workspaceId: string,
  accountId: string,
  reason: string,
  sessionStatus?: "active" | "expired" | "unknown",
): Promise<void> {
  await client.query(
    `UPDATE account_connections SET paused = true, paused_reason = $3,
       session_status = COALESCE($4::text, session_status)
     WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, accountId, reason, sessionStatus ?? null],
  );
  await recordEvent(client, {
    workspaceId,
    accountId,
    type: "account.paused",
    payload: { reason },
    dedupeKey: `account_paused:${accountId}:${reason}`,
  });
  await openIncident(client, {
    workspaceId,
    accountId,
    kind: "account_paused",
    detail: { reason },
  });
}
