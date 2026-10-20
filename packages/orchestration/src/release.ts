import { getDb, withTransaction } from "@aipeople/server-kit";
import { preflightCheck, type PolicyDenyReason } from "@aipeople/policy";
import type { Action, Channel, Platform } from "@aipeople/contracts";
import { transitionTaskState, openIncident, type TaskRow } from "./task-ops.js";
import { channelCapabilities } from "./adapters-registry.js";

/** 瞬时性拒绝：本轮跳过，下个 tick 重试。 */
const TRANSIENT_REASONS = new Set<PolicyDenyReason>(["account_busy"]);

const NEEDS_HUMAN_REASONS = new Set<PolicyDenyReason>([
  "approval_missing",
  "approval_invalid",
  "approval_hash_mismatch",
  "approval_expired",
  "approval_account_mismatch",
  "content_modified",
  "session_expired",
  "capability_unavailable",
  "budget_exceeded",
  "aigc_declaration_unsupported",
]);

/** Runner 心跳有效期（方案 §8：约 90 秒）。 */
export const RUNNER_OFFLINE_MS = 90_000;

/**
 * 到期任务发放（每 tick 调用）：SCHEDULED → PREFLIGHT → WAITING_RUNNER，
 * 校验失败按原因分流 NEEDS_HUMAN / MISSED / 留待重试。
 */
export async function releaseDueTasks(now = new Date()): Promise<{ released: number; needsHuman: number; missed: number }> {
  const pool = getDb();
  const { rows: due } = await pool.query<TaskRow>(
    `SELECT * FROM tasks
     WHERE status = 'SCHEDULED' AND execution_window_start <= now()
     ORDER BY execution_window_start ASC LIMIT 25`,
  );
  let released = 0;
  let needsHuman = 0;
  let missed = 0;

  for (const task of due) {
    const outcome = await withTransaction(async (client) => {
      const fresh = (
        await client.query<TaskRow>(`SELECT * FROM tasks WHERE id = $1 FOR UPDATE`, [task.id])
      ).rows[0];
      if (!fresh || fresh.status !== "SCHEDULED") return "skipped";

      // 排程被暂停 → 取消未开始任务
      if (fresh.schedule_id) {
        const schedule = await client.query<{ active: boolean }>(
          `SELECT active FROM schedules WHERE id = $1`,
          [fresh.schedule_id],
        );
        if (schedule.rows[0] && !schedule.rows[0].active) {
          await transitionTaskState(client, fresh.workspace_id, fresh.id, "SCHEDULED", "CANCELLED", {
            lastError: { code: "schedule_paused", message: "计划已暂停，任务取消" },
          });
          return "cancelled";
        }
      }

      if (now.getTime() > fresh.execution_window_end!.getTime()) {
        await markMissed(client, fresh, "执行窗口已过期");
        return "missed";
      }

      // PREFLIGHT 校验
      const account = (
        await client.query<{
          id: string;
          platform: Platform;
          channel: Channel;
          paused: boolean;
          paused_reason: string | null;
          session_status: "active" | "expired" | "unknown";
          capabilities: string[];
        }>(
          `SELECT id, platform, channel, paused, paused_reason, session_status, capabilities
           FROM account_connections WHERE workspace_id = $1 AND id = $2`,
          [fresh.workspace_id, fresh.account_id],
        )
      ).rows[0];
      const content = (
        await client.query<{ id: string; hash: string; status: string; declarations: { aiGenerated: boolean; commercial: boolean } }>(
          `SELECT id, hash, status, declarations FROM content_versions WHERE workspace_id = $1 AND id = $2`,
          [fresh.workspace_id, fresh.content_version_id],
        )
      ).rows[0];
      const approval = (
        await client.query<{
          id: string;
          status: string;
          content_hash: string;
          account_id: string;
          action: Action;
          expires_at: Date;
        }>(
          `SELECT id, status, content_hash, account_id, action, expires_at
           FROM approvals WHERE workspace_id = $1 AND id = $2`,
          [fresh.workspace_id, fresh.approval_id],
        )
      ).rows[0];
      const workspace = (
        await client.query<{ aigc_policy: "strict" | "in_text" | "off"; daily_budget_cny: number | null }>(
          `SELECT aigc_policy, daily_budget_cny FROM workspaces WHERE id = $1`,
          [fresh.workspace_id],
        )
      ).rows[0];
      const inFlight = (
        await client.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM tasks
           WHERE account_id = $1 AND id != $2 AND status IN ('WAITING_RUNNER', 'RUNNING', 'SUBMITTED', 'UNKNOWN')`,
          [fresh.account_id, fresh.id],
        )
      ).rows[0];
      const spent = (
        await client.query<{ total: number | null }>(
          `SELECT COALESCE(SUM(amount_cny), 0) AS total FROM cost_ledger
           WHERE workspace_id = $1 AND created_at >= date_trunc('day', now())`,
          [fresh.workspace_id],
        )
      ).rows[0];

      if (!account || !content) {
        await transitionTaskState(client, fresh.workspace_id, fresh.id, "SCHEDULED", "FAILED", {
          lastError: { code: "missing_data", message: "账号或内容版本缺失" },
        });
        return "failed";
      }

      const decision = preflightCheck({
        now,
        task: {
          accountId: fresh.account_id,
          platform: fresh.platform as Platform,
          channel: fresh.channel as Channel,
          action: fresh.action as Action,
          contentHash: fresh.content_hash,
          approvalId: fresh.approval_id,
          scheduledAt: fresh.occurrence_at,
          expiresAt: fresh.execution_window_end!,
        },
        account: {
          id: account.id,
          platform: account.platform,
          channel: account.channel,
          paused: account.paused,
          pausedReason: account.paused_reason,
          sessionStatus: account.session_status,
          grantedActions: account.capabilities ?? [],
        },
        contentVersion: { id: content.id, hash: content.hash, status: content.status, declarations: content.declarations },
        approval: approval
          ? {
              id: approval.id,
              status: approval.status,
              contentHash: approval.content_hash,
              accountId: approval.account_id,
              action: approval.action,
              expiresAt: approval.expires_at,
            }
          : null,
        workspace: { aigcPolicy: workspace?.aigc_policy ?? "strict", dailyBudgetCny: workspace?.daily_budget_cny ?? null },
        accountInFlight: Number(inFlight?.count ?? 0),
        spentTodayCny: Number(spent?.total ?? 0),
        channelCapabilities: channelCapabilities(fresh.channel as Channel),
      });

      if (decision.allowed) {
        await transitionTaskState(client, fresh.workspace_id, fresh.id, "SCHEDULED", "PREFLIGHT");
        // 指派在线 Runner（支持该通道适配器）；无在线设备时留空，由任意配对 Runner 领取
        const runner = (
          await client.query<{ id: string }>(
            `SELECT id FROM runners
             WHERE workspace_id = $1 AND status = 'paired'
               AND last_heartbeat_at > now() - interval '90 seconds'
               AND adapters @> $2::jsonb
             ORDER BY last_heartbeat_at DESC NULLS LAST LIMIT 1`,
            [fresh.workspace_id, JSON.stringify([fresh.channel])],
          )
        ).rows[0];
        const assigned = await transitionTaskState(client, fresh.workspace_id, fresh.id, "PREFLIGHT", "WAITING_RUNNER", {
          runnerId: runner?.id ?? null,
        });
        if (assigned) return "released";
        return "skipped";
      }

      if (TRANSIENT_REASONS.has(decision.reason)) return "retry";
      if (decision.reason === "window_expired" || decision.reason === "account_paused") {
        await markMissed(client, fresh, decision.detail);
        return "missed";
      }
      if (NEEDS_HUMAN_REASONS.has(decision.reason) || !decision.allowed) {
        await transitionTaskState(client, fresh.workspace_id, fresh.id, "SCHEDULED", "PREFLIGHT");
        await transitionTaskState(client, fresh.workspace_id, fresh.id, "PREFLIGHT", "NEEDS_HUMAN", {
          lastError: { code: decision.reason, message: decision.detail },
        });
        await openIncident(client, {
          workspaceId: fresh.workspace_id,
          accountId: fresh.account_id,
          taskId: fresh.id,
          kind: `preflight_${decision.reason}`,
          detail: { reason: decision.reason, message: decision.detail },
        });
        return "needs_human";
      }
      return "skipped";
    }).catch((error) => {
      console.error(`[release] 任务 ${task.id} 处理失败：`, error instanceof Error ? error.message : error);
      return "error" as const;
    });

    if (outcome === "released") released += 1;
    else if (outcome === "needs_human") needsHuman += 1;
    else if (outcome === "missed") missed += 1;
  }
  return { released, needsHuman, missed };
}

/** 清扫：WAITING_RUNNER 超过执行窗口 → MISSED；账号暂停的排队任务 → MISSED。 */
export async function sweepStaleWaitingTasks(now = new Date()): Promise<number> {
  const pool = getDb();
  const { rows } = await pool.query<TaskRow>(
    `SELECT * FROM tasks WHERE status = 'WAITING_RUNNER' AND execution_window_end < $1 LIMIT 50`,
    [now],
  );
  let missed = 0;
  for (const task of rows) {
    const done = await withTransaction(async (client) => {
      const fresh = (await client.query<TaskRow>(`SELECT * FROM tasks WHERE id = $1 FOR UPDATE`, [task.id])).rows[0];
      if (!fresh || fresh.status !== "WAITING_RUNNER") return false;
      await markMissed(client, fresh, "执行窗口过期，执行设备未领取");
      return true;
    });
    if (done) missed += 1;
  }
  return missed;
}

async function markMissed(client: Parameters<typeof transitionTaskState>[0], task: TaskRow, reason: string): Promise<void> {
  const from = task.status;
  await transitionTaskState(client, task.workspace_id, task.id, from, "MISSED", {
    lastError: { code: "window_expired", message: reason },
  });
  await openIncident(client, {
    workspaceId: task.workspace_id,
    accountId: task.account_id,
    taskId: task.id,
    kind: "task_missed",
    detail: { reason },
  });
}
