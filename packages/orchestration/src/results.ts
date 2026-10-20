import { getDb, withTransaction, randomId } from "@aipeople/server-kit";
import type { AdapterErrorCode, RunnerResult } from "@aipeople/contracts";
import { transitionTaskState, pauseAccount, openIncident, type TaskRow } from "./task-ops.js";
import { recordEvent } from "./events.js";

/** 需要暂停账号外发的错误（方案 §5.3 风险处置矩阵）。 */
const PAUSE_ERRORS: ReadonlySet<string> = new Set(["needs_verify", "session_expired", "ip_blocked"]);

export interface IngestContext {
  /** 上报方 Runner（内部执行器为 null）。 */
  runnerId: string | null;
}

/**
 * 结果入账（Runner / 内部执行器统一入口）。
 * 幂等：尝试记录已有 finished_at 时直接返回，重复上报安全（方案 §4.3）。
 */
export async function ingestRunnerResult(
  result: RunnerResult,
  ctx: IngestContext,
): Promise<{ ok: true; ignored?: boolean } | { ok: false; message: string }> {
  return await withTransaction(async (client) => {
    const task = (
      await client.query<TaskRow>(`SELECT * FROM tasks WHERE id = $1 FOR UPDATE`, [result.taskId])
    ).rows[0];
    if (!task) return { ok: false, message: `任务不存在：${result.taskId}` };

    const attempt = (
      await client.query<{ id: string; runner_id: string | null; finished_at: Date | null }>(
        `SELECT id, runner_id, finished_at FROM task_attempts WHERE id = $1`,
        [result.attemptId],
      )
    ).rows[0];
    if (!attempt) return { ok: false, message: `尝试记录不存在：${result.attemptId}` };
    if (attempt.finished_at) return { ok: true, ignored: true };
    if (ctx.runnerId && attempt.runner_id && attempt.runner_id !== ctx.runnerId) {
      return { ok: false, message: "尝试记录与上报设备不符" };
    }

    const lastError = result.errorCode
      ? { code: result.errorCode, message: result.errorMessage ?? "" }
      : null;

    // 1) 尝试记录收尾
    await client.query(
      `UPDATE task_attempts SET finished_at = now(), outcome = $2, error_code = $3, error_message = $4, raw = $5
       WHERE id = $1`,
      [result.attemptId, result.outcome, result.errorCode ?? null, result.errorMessage ?? null, result.raw ? JSON.stringify(result.raw) : null],
    );

    // 2) 状态迁移 + Publication
    if (result.outcome === "submitted") {
      const moved = await transitionTaskState(client, task.workspace_id, task.id, "RUNNING", "SUBMITTED");
      if (!moved) return { ok: true, ignored: true };
      await upsertPublication(client, task, {
        executionStatus: "submitted",
        publicationStatus: "unverified",
        externalId: result.externalId ?? null,
        url: result.url ?? null,
        raw: result.raw ?? null,
        nextAction: "wait_or_verify",
      });
      await recordEvent(client, {
        workspaceId: task.workspace_id,
        taskId: task.id,
        accountId: task.account_id,
        type: "publication.submitted",
        payload: { externalId: result.externalId ?? null, url: result.url ?? null },
        dedupeKey: `submitted:${result.attemptId}`,
      });
      return { ok: true };
    }

    if (result.outcome === "needs_human") {
      const moved = await transitionTaskState(client, task.workspace_id, task.id, "RUNNING", "NEEDS_HUMAN", { lastError });
      if (!moved) return { ok: true, ignored: true };
      if (result.errorCode && PAUSE_ERRORS.has(result.errorCode)) {
        await pauseAccount(
          client,
          task.workspace_id,
          task.account_id,
          result.errorMessage ?? "平台拦截，暂停外发等待人工处理",
          result.errorCode === "session_expired" ? "expired" : undefined,
        );
      }
      await openIncident(client, {
        workspaceId: task.workspace_id,
        accountId: task.account_id,
        taskId: task.id,
        kind: `adapter_${result.errorCode ?? "needs_human"}`,
        detail: { message: result.errorMessage ?? "", attemptId: result.attemptId },
      });
      await upsertPublication(client, task, {
        executionStatus: "needs_human",
        publicationStatus: "unverified",
        externalId: null,
        url: null,
        raw: result.raw ?? null,
        nextAction: "manual_intervention",
      });
      return { ok: true };
    }

    if (result.outcome === "failed") {
      const moved = await transitionTaskState(client, task.workspace_id, task.id, "RUNNING", "FAILED", { lastError });
      if (!moved) return { ok: true, ignored: true };
      if (result.errorCode === "session_expired") {
        await pauseAccount(client, task.workspace_id, task.account_id, "会话失效", "expired");
      }
      await upsertPublication(client, task, {
        executionStatus: "failed",
        publicationStatus: "unverified",
        externalId: null,
        url: null,
        raw: result.raw ?? null,
        nextAction: null,
      });
      return { ok: true };
    }

    // unknown：提交可能已发生，禁止自动重试，进入对账
    const movedUnknown = await transitionTaskState(client, task.workspace_id, task.id, "RUNNING", "UNKNOWN", { lastError });
    if (!movedUnknown) return { ok: true, ignored: true };
    await upsertPublication(client, task, {
      executionStatus: "unknown",
      publicationStatus: "unknown",
      externalId: result.externalId ?? null,
      url: result.url ?? null,
      raw: result.raw ?? null,
      nextAction: "reconcile",
    });
    await openIncident(client, {
      workspaceId: task.workspace_id,
      accountId: task.account_id,
      taskId: task.id,
      kind: "submission_unknown",
      detail: { message: result.errorMessage ?? "提交结果未确认", attemptId: result.attemptId },
    });
    return { ok: true };
  });
}

async function upsertPublication(
  client: Parameters<typeof transitionTaskState>[0],
  task: TaskRow,
  values: {
    executionStatus: "submitted" | "failed" | "unknown" | "needs_human";
    publicationStatus: "unverified" | "under_review" | "published" | "rejected" | "unknown";
    externalId: string | null;
    url: string | null;
    raw: unknown;
    nextAction: string | null;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO publications (id, workspace_id, task_id, platform, account_id, external_id, url,
        execution_status, publication_status, confirmation_source, next_action, raw_receipt)
     VALUES ($11, $1, $2, $3, $4, $5, $6, $7, $8, 'adapter_receipt', $9, $10)
     ON CONFLICT (task_id) DO UPDATE SET
       external_id = COALESCE(EXCLUDED.external_id, publications.external_id),
       url = COALESCE(EXCLUDED.url, publications.url),
       execution_status = EXCLUDED.execution_status,
       publication_status = EXCLUDED.publication_status,
       next_action = EXCLUDED.next_action,
       raw_receipt = COALESCE(EXCLUDED.raw_receipt, publications.raw_receipt),
       updated_at = now()`,
    [
      task.workspace_id,
      task.id,
      task.platform,
      task.account_id,
      values.externalId,
      values.url,
      values.executionStatus,
      values.publicationStatus,
      values.nextAction,
      values.raw ? JSON.stringify(values.raw) : null,
      randomId("pub"),
    ],
  );
}

/** 人工登记发布链接（方案 §9.2：标记 manual，不与接口确认混淆）。 */
export async function manuallyConfirmPublication(
  workspaceId: string,
  taskId: string,
  url: string,
): Promise<boolean> {
  return await withTransaction(async (client) => {
    const updated = await client.query(
      `UPDATE publications SET manual_confirmed = true, url = $3,
         publication_status = 'published', confirmation_source = 'manual', updated_at = now()
       WHERE workspace_id = $1 AND task_id = $2`,
      [workspaceId, taskId, url],
    );
    if (updated.rowCount === 0) return false;
    await client.query(
      `UPDATE tasks SET status = 'PUBLISHED', updated_at = now() WHERE workspace_id = $1 AND id = $2 AND status NOT IN ('PUBLISHED', 'CANCELLED')`,
      [workspaceId, taskId],
    );
    await recordEvent(client, {
      workspaceId,
      taskId,
      type: "publication.status_changed",
      payload: { publicationStatus: "published", confirmationSource: "manual", url },
      dedupeKey: `manual_confirm:${taskId}`,
    });
    return true;
  });
}
