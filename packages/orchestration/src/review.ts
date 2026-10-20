import { getDb, withTransaction, randomId } from "@aipeople/server-kit";
import type { Channel, Platform, PublicationStatus } from "@aipeople/contracts";
import { transitionTaskState, openIncident, type TaskRow } from "./task-ops.js";
import { recordEvent } from "./events.js";

interface TaskWithPublication extends TaskRow {
  external_id: string | null;
  url: string | null;
}

/**
 * 模拟平台审核推进（仅 simulator 通道）：
 * SUBMITTED --4s--> UNDER_REVIEW --8s--> PUBLISHED，附模拟指标快照。
 * 真实平台的公开状态由对账/回读更新，不用本函数。
 */
export async function advanceSimulatorReview(now = new Date()): Promise<void> {
  const pool = getDb();

  const submitted = await pool.query<TaskWithPublication>(
    `SELECT t.*, p.external_id, p.url FROM tasks t JOIN publications p ON p.task_id = t.id
     WHERE t.channel = 'simulator' AND t.status = 'SUBMITTED' AND t.updated_at < $1 LIMIT 20`,
    [new Date(now.getTime() - 4000)],
  );
  for (const task of submitted.rows) {
    await withTransaction(async (client) => {
      const moved = await transitionTaskState(client, task.workspace_id, task.id, "SUBMITTED", "UNDER_REVIEW");
      if (!moved) return;
      await client.query(
        `UPDATE publications SET publication_status = 'under_review', updated_at = now() WHERE task_id = $1`,
        [task.id],
      );
      await recordEvent(client, {
        workspaceId: task.workspace_id,
        taskId: task.id,
        type: "publication.status_changed",
        payload: { publicationStatus: "under_review" },
        dedupeKey: `review:${task.id}`,
      });
    }).catch(() => {});
  }

  const reviewing = await pool.query<TaskWithPublication>(
    `SELECT t.*, p.external_id, p.url FROM tasks t JOIN publications p ON p.task_id = t.id
     WHERE t.channel = 'simulator' AND t.status = 'UNDER_REVIEW' AND t.updated_at < $1 LIMIT 20`,
    [new Date(now.getTime() - 8000)],
  );
  for (const task of reviewing.rows) {
    await withTransaction(async (client) => {
      const moved = await transitionTaskState(client, task.workspace_id, task.id, "UNDER_REVIEW", "PUBLISHED");
      if (!moved) return;
      const url = task.url ?? `https://sim.aipeople.local/${task.platform}/${task.external_id ?? task.id}`;
      await client.query(
        `UPDATE publications SET publication_status = 'published', confirmation_source = 'platform_verified',
           url = $2, next_action = null, updated_at = now() WHERE task_id = $1`,
        [task.id, url],
      );
      await client.query(
        `INSERT INTO metric_snapshots (id, publication_id, metrics, source)
         SELECT $3, p.id, $2::jsonb, 'simulator' FROM publications p WHERE p.task_id = $1`,
        [task.id, JSON.stringify(simulatedMetrics()), randomId("metric")],
      );
      await recordEvent(client, {
        workspaceId: task.workspace_id,
        taskId: task.id,
        type: "publication.status_changed",
        payload: { publicationStatus: "published", url },
        dedupeKey: `published:${task.id}`,
      });
    }).catch(() => {});
  }
}

function simulatedMetrics(): Record<string, number> {
  const rand = (min: number, max: number) => Math.floor(min + Math.random() * (max - min));
  return { impressions: rand(120, 3600), views: rand(80, 2400), likes: rand(5, 180), comments: rand(0, 24), collects: rand(2, 60) };
}

/**
 * UNKNOWN 任务对账（方案 §9.2）：先尝试通道 reconcile；
 * 模拟器可回读；真实通道无法确认时转 NEEDS_HUMAN，绝不自动重发。
 */
export async function reconcileUnknownTasks(now = new Date()): Promise<void> {
  const pool = getDb();
  const { rows } = await pool.query<TaskWithPublication>(
    `SELECT t.*, p.external_id FROM tasks t JOIN publications p ON p.task_id = t.id
     WHERE t.status = 'UNKNOWN' AND t.updated_at < $1 LIMIT 10`,
    [new Date(now.getTime() - 90_000)],
  );
  for (const task of rows) {
    if (task.channel === "simulator") {
      // 模拟平台可回读：90 秒后确认已公开
      await withTransaction(async (client) => {
        const moved = await transitionTaskState(client, task.workspace_id, task.id, "UNKNOWN", "PUBLISHED");
        if (!moved) return;
        await client.query(
          `UPDATE publications SET publication_status = 'published', confirmation_source = 'platform_verified',
             next_action = null, updated_at = now() WHERE task_id = $1`,
          [task.id],
        );
        await recordEvent(client, {
          workspaceId: task.workspace_id,
          taskId: task.id,
          type: "publication.status_changed",
          payload: { publicationStatus: "published", via: "reconcile" },
          dedupeKey: `reconcile_ok:${task.id}`,
        });
      }).catch(() => {});
    } else {
      // 真实通道：无法自动确认 → 人工核实（后续版本接入各通道 reconcile 回读）
      await withTransaction(async (client) => {
        const moved = await transitionTaskState(client, task.workspace_id, task.id, "UNKNOWN", "NEEDS_HUMAN", {
          lastError: { code: "reconcile_unconfirmed", message: "提交结果长时间未确认，需人工在平台核实" },
        });
        if (!moved) return;
        await openIncident(client, {
          workspaceId: task.workspace_id,
          accountId: task.account_id,
          taskId: task.id,
          kind: "reconcile_unconfirmed",
          detail: { externalId: task.external_id },
        });
      }).catch(() => {});
    }
  }
}

export type { TaskWithPublication };
