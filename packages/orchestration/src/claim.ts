import { getDb, withTransaction, randomId } from "@aipeople/server-kit";
import {
  TaskEnvelopeSchema,
  type Channel,
  type Platform,
  type TaskEnvelope,
} from "@aipeople/contracts";
import { transitionTaskState } from "./task-ops.js";
import { recordEvent } from "./events.js";

export interface ClaimOptions {
  /** 设备 Runner 领取：校验设备身份。 */
  runnerId?: string;
  /** 内部执行器（后台 Worker 直接执行官方 API 通道）。 */
  internalChannel?: Channel;
  /** 长轮询等待（毫秒）；0 表示立即返回。 */
  waitMs?: number;
}

interface TaskJoinRow {
  id: string;
  workspace_id: string;
  platform: Platform;
  channel: Channel;
  account_id: string;
  account_uid: string;
  action: string;
  content_version_id: string;
  content_hash: string;
  approval_id: string;
  occurrence_at: Date;
  execution_window_end: Date;
  runner_id: string | null;
  attempts: number;
  scenario: string | null;
  timezone: string;
  title: string;
  body: string;
  topics: string[];
  asset_ids: string[];
  declarations: { aiGenerated: boolean; commercial: boolean };
  asset_paths: string[];
}

/**
 * 领取一个到期任务：WAITING_RUNNER → RUNNING，创建尝试记录并返回任务信封。
 * 同一时刻只发放一个（FOR UPDATE SKIP LOCKED）。
 */
export async function claimNextTask(options: ClaimOptions): Promise<TaskEnvelope | null> {
  const deadline = Date.now() + (options.waitMs ?? 0);
  do {
    const envelope = await tryClaim(options);
    if (envelope) return envelope;
    if (Date.now() >= deadline) return null;
    await sleep(1000);
  } while (true);
}

async function tryClaim(options: ClaimOptions): Promise<TaskEnvelope | null> {
  return await withTransaction(async (client) => {
    let runnerWorkspace: string | null = null;
    if (options.runnerId) {
      const runner = (
        await client.query<{ workspace_id: string; status: string; adapters: string[] }>(
          `SELECT workspace_id, status, adapters FROM runners WHERE id = $1`,
          [options.runnerId],
        )
      ).rows[0];
      if (!runner || runner.status !== "paired") return null;
      runnerWorkspace = runner.workspace_id;
    }

    // 条件与参数按出现顺序构造，避免未引用参数
    const conditions: string[] = [];
    const params: unknown[] = [];
    conditions.push("t.platform <> 'xiaohongshu'");
    const nextParam = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    if (options.runnerId) conditions.push(`(t.runner_id IS NULL OR t.runner_id = ${nextParam(options.runnerId)})`);
    if (runnerWorkspace) conditions.push(`t.workspace_id = ${nextParam(runnerWorkspace)}`);
    if (options.internalChannel) conditions.push(`t.channel = ${nextParam(options.internalChannel)}`);
    const conditionSql = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";

    const task = (
      await client.query<TaskJoinRow>(
        `SELECT t.id, t.workspace_id, t.platform, t.channel, t.account_id, ac.uid AS account_uid,
                t.action, t.content_version_id, t.content_hash, t.approval_id, t.occurrence_at,
                t.execution_window_end, t.runner_id, t.attempts, t.scenario, s.timezone,
                cv.title, cv.body, cv.topics, cv.asset_ids, cv.declarations,
                COALESCE(
                  (SELECT json_agg(a.file_path ORDER BY ord.ordinality)::jsonb
                   FROM jsonb_array_elements_text(cv.asset_ids) WITH ORDINALITY AS ord(value, ordinality)
                   JOIN assets a ON a.id = ord.value AND a.workspace_id = t.workspace_id),
                  '[]'::jsonb
                ) AS asset_paths
         FROM tasks t
         JOIN account_connections ac ON ac.id = t.account_id AND ac.workspace_id = t.workspace_id
         JOIN content_versions cv ON cv.id = t.content_version_id AND cv.workspace_id = t.workspace_id
         LEFT JOIN schedules s ON s.id = t.schedule_id
         WHERE t.status = 'WAITING_RUNNER'
           AND t.execution_window_start <= now()
           AND t.execution_window_end > now()
           ${conditionSql}
         ORDER BY t.occurrence_at ASC
         FOR UPDATE OF t SKIP LOCKED
         LIMIT 1`,
        params,
      )
    ).rows[0];
    if (!task) return null;

    const attemptNo = task.attempts + 1;
    const attempt = (
      await client.query<{ id: string }>(
        `INSERT INTO task_attempts (id, workspace_id, task_id, attempt_no, runner_id)
         VALUES ($5, $1, $2, $3, $4) RETURNING id`,
        [task.workspace_id, task.id, attemptNo, options.runnerId ?? null, randomId("att")],
      )
    ).rows[0]!;

    await client.query(`UPDATE tasks SET attempts = $2, runner_id = COALESCE($3, runner_id), updated_at = now() WHERE id = $1`, [
      task.id,
      attemptNo,
      options.runnerId ?? null,
    ]);
    const moved = await transitionTaskState(client, task.workspace_id, task.id, "WAITING_RUNNER", "RUNNING");
    if (!moved) return null;

    const envelope = TaskEnvelopeSchema.parse({
      taskId: task.id,
      attemptId: attempt.id,
      workspaceId: task.workspace_id,
      platform: task.platform,
      channel: task.channel,
      accountId: task.account_id,
      accountUid: task.account_uid,
      action: task.action,
      contentVersionId: task.content_version_id,
      contentHash: task.content_hash,
      approvalId: task.approval_id,
      scheduledAt: task.occurrence_at.toISOString(),
      expiresAt: task.execution_window_end.toISOString(),
      timezone: task.timezone ?? "Asia/Shanghai",
      runnerId: options.runnerId ?? `internal:${task.channel}`,
      scenario: task.scenario ?? undefined,
      content: {
        title: task.title,
        body: task.body,
        topics: task.topics ?? [],
        assetPaths: task.asset_paths ?? [],
        declarations: task.declarations ?? { aiGenerated: false, commercial: false },
      },
    });
    await recordEvent(client, {
      workspaceId: task.workspace_id,
      taskId: task.id,
      accountId: task.account_id,
      type: "task.state_changed",
      payload: { from: "WAITING_RUNNER", to: "RUNNING", attemptId: attempt.id },
      dedupeKey: `claimed:${attempt.id}`,
    });
    return envelope;
  }).catch((error) => {
    console.error("[claim] 领取失败：", error instanceof Error ? error.message : error);
    return null;
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
