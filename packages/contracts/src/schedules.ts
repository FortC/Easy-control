import { z } from "zod";
import { ACTIONS, PLATFORMS } from "./platforms.js";

/**
 * 计划（方案 §8）。单次 = mode 'single'；周期 = mode 'recurring'
 * （weekdays + 每日时间，界面表单选择，不要求用户手写 cron）。
 * 一个定时发布条目只对应一个确定的内容版本，不允每次执行时换内容。
 */
export const ScheduleMode = ["single", "recurring"] as const;
export type ScheduleMode = (typeof ScheduleMode)[number];

export const CreateScheduleSchema = z
  .object({
    mode: z.enum(ScheduleMode),
    contentVersionId: z.string().min(1),
    approvalId: z.string().min(1),
    accountId: z.string().min(1),
    platform: z.enum(PLATFORMS),
    action: z.enum(ACTIONS),
    timezone: z.string().default("Asia/Shanghai"),
    /** single：ISO 时间（用户时区语义）。 */
    at: z.string().optional(),
    /** recurring：每周几（1=周一 … 7=周日）+ 当地时间 HH:mm。 */
    weekdays: z.array(z.number().int().min(1).max(7)).default([]),
    timeOfDay: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    /** recurring：从哪天开始（YYYY-MM-DD，默认明天）。 */
    startDate: z.string().optional(),
    /** recurring：结束日期（含）。 */
    untilDate: z.string().optional(),
    /** 过期窗口（分钟）：错过执行时间多久后标记 MISSED，默认 30。 */
    expireMinutes: z.number().int().min(1).max(24 * 60).default(30),
  })
  .refine((v) => (v.mode === "single" ? Boolean(v.at) : v.weekdays.length > 0 && Boolean(v.timeOfDay)), {
    message: "单次计划需要 at；周期计划需要 weekdays 和 timeOfDay",
  });

export type CreateScheduleInput = z.infer<typeof CreateScheduleSchema>;

export interface Schedule {
  id: string;
  workspaceId: string;
  mode: ScheduleMode;
  platform: string;
  accountId: string;
  action: string;
  contentVersionId: string;
  approvalId: string;
  timezone: string;
  at: string | null;
  weekdays: number[];
  timeOfDay: string | null;
  startDate: string | null;
  untilDate: string | null;
  expireMinutes: number;
  active: boolean;
  createdBy: string;
  createdAt: string;
}

/** 物化执行实例的唯一键组成（方案 §8：schedule_id + occurrence_at + account_id + action）。 */
export function occurrenceIdempotencyKey(
  scheduleId: string,
  occurrenceAt: Date,
  accountId: string,
  action: string,
): string {
  return `sched:${scheduleId}:${occurrenceAt.toISOString()}:${accountId}:${action}`;
}
