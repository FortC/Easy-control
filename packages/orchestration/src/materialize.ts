import { getDb, withTransaction, randomId, type DbClient } from "@aipeople/server-kit";
import { occurrenceIdempotencyKey, type Action, type Platform } from "@aipeople/contracts";
import { recordEvent, insertOutbox } from "./events.js";
import { addDaysYMD, zonedTimeToUtc, zonedWeekday, zonedToday } from "./time.js";

interface ScheduleRow {
  id: string;
  workspace_id: string;
  mode: "single" | "recurring";
  platform: Platform;
  account_id: string;
  action: Action;
  content_version_id: string;
  approval_id: string;
  timezone: string;
  at: Date | null;
  weekdays: number[];
  time_of_day: string | null;
  start_date: string | null;
  until_date: string | null;
  expire_minutes: number;
  active: boolean;
}

/** 单次计划最多提前物化 10 分钟；周期计划滚动预生成 7 天。 */
const SINGLE_HORIZON_MS = 10 * 60_000;
const RECURRING_HORIZON_DAYS = 7;

/**
 * 物化执行实例（方案 §8）：以 schedule_id + occurrence_at + account_id + action
 * 唯一键防重；停机恢复后再次运行即可补齐缺失实例。
 */
export async function materializeDueSchedules(now = new Date()): Promise<number> {
  const client = await getDb().connect();
  let created = 0;
  try {
    const { rows } = await client.query<ScheduleRow>(
      `SELECT id, workspace_id, mode, platform, account_id, action, content_version_id, approval_id,
              timezone, at, weekdays, time_of_day, start_date::text AS start_date,
              until_date::text AS until_date, expire_minutes, active
       FROM schedules WHERE active = true`,
    );
    for (const schedule of rows) {
      const occurrences = computeOccurrences(schedule, now);
      for (const occurrenceAt of occurrences) {
        const ok = await createTaskIfAbsent(client, schedule, occurrenceAt);
        if (ok) created += 1;
      }
    }
  } finally {
    client.release();
  }
  return created;
}

export function computeOccurrences(schedule: ScheduleRow, now: Date): Date[] {
  if (schedule.mode === "single") {
    if (!schedule.at) return [];
    const at = new Date(schedule.at);
    if (at.getTime() > now.getTime() + SINGLE_HORIZON_MS) return [];
    return [at];
  }
  if (!schedule.time_of_day) return [];
  const tz = schedule.timezone || "Asia/Shanghai";
  const today = zonedToday(tz, now);
  const start = schedule.start_date && schedule.start_date > today ? schedule.start_date : today;
  const end = addDaysYMD(today, RECURRING_HORIZON_DAYS);
  const finalDay = schedule.until_date && schedule.until_date < end ? schedule.until_date : end;
  const weekdays = new Set(schedule.weekdays ?? []);
  const result: Date[] = [];
  for (let day = start; day <= finalDay; day = addDaysYMD(day, 1)) {
    const instant = zonedTimeToUtc(day, schedule.time_of_day, tz);
    if (instant.getTime() <= now.getTime()) continue; // 已过去的本次不补
    if (weekdays.size > 0 && !weekdays.has(zonedWeekday(instant, tz).weekday)) continue;
    result.push(instant);
  }
  return result;
}

async function createTaskIfAbsent(client: DbClient, schedule: ScheduleRow, occurrenceAt: Date): Promise<boolean> {
  const idempotencyKey = occurrenceIdempotencyKey(schedule.id, occurrenceAt, schedule.account_id, schedule.action);
  const windowEnd = new Date(occurrenceAt.getTime() + schedule.expire_minutes * 60_000);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO tasks (id, workspace_id, schedule_id, occurrence_at, platform, channel, account_id, action,
       content_version_id, approval_id, content_hash, status, execution_window_start, execution_window_end,
       idempotency_key)
     SELECT $11, $1, $2, $3, $4, ac.channel, $5, $6, $7, $8, cv.hash, 'SCHEDULED', $3, $9, $10
     FROM account_connections ac, content_versions cv
     WHERE ac.id = $5 AND ac.workspace_id = $1 AND cv.id = $7 AND cv.workspace_id = $1
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      schedule.workspace_id,
      schedule.id,
      occurrenceAt,
      schedule.platform,
      schedule.account_id,
      schedule.action,
      schedule.content_version_id,
      schedule.approval_id,
      windowEnd,
      idempotencyKey,
      randomId("task"),
    ],
  );
  const row = inserted.rows[0];
  if (!row) return false;
  await recordEvent(client, {
    workspaceId: schedule.workspace_id,
    taskId: row.id,
    accountId: schedule.account_id,
    type: "task.created",
    payload: {
      taskId: row.id,
      platform: schedule.platform,
      action: schedule.action,
      occurrenceAt: occurrenceAt.toISOString(),
      scheduleId: schedule.id,
    },
    dedupeKey: `task_created:${idempotencyKey}`,
  });
  await insertOutbox(client, schedule.workspace_id, "release_at", {
    taskId: row.id,
    runAt: occurrenceAt.toISOString(),
  });
  return true;
}

/** 立即为单次排程创建任务（排程接口同步调用，不等待物化定时器）。返回任务 ID。 */
export async function materializeSingleScheduleNow(scheduleId: string): Promise<string | null> {
  return await withTransaction(async (client) => {
    const { rows } = await client.query<ScheduleRow>(
      `SELECT id, workspace_id, mode, platform, account_id, action, content_version_id, approval_id,
              timezone, at, weekdays, time_of_day, start_date::text AS start_date,
              until_date::text AS until_date, expire_minutes, active
       FROM schedules WHERE id = $1`,
      [scheduleId],
    );
    const schedule = rows[0];
    if (!schedule || schedule.mode !== "single" || !schedule.at) return null;
    const idempotencyKey = occurrenceIdempotencyKey(schedule.id, new Date(schedule.at), schedule.account_id, schedule.action);
    const created = await createTaskIfAbsent(client, schedule, new Date(schedule.at));
    if (created) {
      const task = await client.query<{ id: string }>(`SELECT id FROM tasks WHERE idempotency_key = $1`, [idempotencyKey]);
      return task.rows[0]?.id ?? null;
    }
    const existing = await client.query<{ id: string }>(`SELECT id FROM tasks WHERE idempotency_key = $1`, [idempotencyKey]);
    return existing.rows[0]?.id ?? null;
  });
}
