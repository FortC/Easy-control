/**
 * 任务状态机（依据 docs/construction-plan.zh-CN.md §9.1）。
 *
 * SCHEDULED → PREFLIGHT → WAITING_RUNNER → RUNNING → SUBMITTED → UNDER_REVIEW → PUBLISHED
 * 异常分支：NEEDS_HUMAN / FAILED / UNKNOWN / MISSED / CANCELLED / REJECTED
 */

export const TASK_STATES = [
  "SCHEDULED",
  "PREFLIGHT",
  "WAITING_RUNNER",
  "RUNNING",
  "SUBMITTED",
  "UNDER_REVIEW",
  "PUBLISHED",
  "REJECTED",
  "NEEDS_HUMAN",
  "FAILED",
  "UNKNOWN",
  "MISSED",
  "CANCELLED",
] as const;

export type TaskState = (typeof TASK_STATES)[number];

export const TERMINAL_TASK_STATES: readonly TaskState[] = [
  "PUBLISHED",
  "REJECTED",
  "FAILED",
  "MISSED",
  "CANCELLED",
];

/** 合法状态迁移表。未列出的迁移一律非法。 */
export const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  SCHEDULED: ["PREFLIGHT", "CANCELLED", "MISSED"],
  PREFLIGHT: ["WAITING_RUNNER", "RUNNING", "NEEDS_HUMAN", "FAILED", "CANCELLED", "MISSED"],
  WAITING_RUNNER: ["RUNNING", "NEEDS_HUMAN", "MISSED", "CANCELLED"],
  RUNNING: ["SUBMITTED", "FAILED", "UNKNOWN", "NEEDS_HUMAN"],
  SUBMITTED: ["UNDER_REVIEW", "PUBLISHED", "REJECTED", "UNKNOWN", "NEEDS_HUMAN"],
  UNDER_REVIEW: ["PUBLISHED", "REJECTED", "UNKNOWN"],
  UNKNOWN: ["SUBMITTED", "PUBLISHED", "UNDER_REVIEW", "FAILED", "NEEDS_HUMAN"],
  NEEDS_HUMAN: ["SCHEDULED", "CANCELLED"],
  PUBLISHED: [],
  REJECTED: [],
  FAILED: [],
  MISSED: [],
  CANCELLED: [],
};

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: TaskState,
    public readonly to: TaskState,
  ) {
    super(`非法的任务状态迁移：${from} → ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function assertTransition(from: TaskState, to: TaskState): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

export function isTerminal(state: TaskState): boolean {
  return TERMINAL_TASK_STATES.includes(state);
}

/** 面向界面的状态中文说明。 */
export const TASK_STATE_LABELS: Record<TaskState, string> = {
  SCHEDULED: "已排程",
  PREFLIGHT: "发布前检查",
  WAITING_RUNNER: "等待执行设备",
  RUNNING: "执行中",
  SUBMITTED: "已提交",
  UNDER_REVIEW: "平台审核中",
  PUBLISHED: "已发布",
  REJECTED: "平台拒绝",
  NEEDS_HUMAN: "需人工处理",
  FAILED: "失败",
  UNKNOWN: "结果未确认",
  MISSED: "已错过窗口",
  CANCELLED: "已取消",
};

/** Publication 的公开状态（与任务执行状态分开，见方案 §10）。 */
export const PUBLICATION_STATUSES = [
  "unverified",
  "under_review",
  "published",
  "rejected",
  "unknown",
] as const;
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];

export const PUBLICATION_STATUS_LABELS: Record<PublicationStatus, string> = {
  unverified: "公开状态未确认",
  under_review: "审核中",
  published: "已公开",
  rejected: "被拒绝",
  unknown: "未知",
};
