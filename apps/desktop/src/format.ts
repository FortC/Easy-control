export const PLATFORM_LABELS: Record<string, string> = {
  xiaohongshu: "小红书",
  weibo: "微博",
  douyin: "抖音",
};

export const CHANNEL_LABELS: Record<string, string> = {
  simulator: "模拟器",
  weibo_cli: "微博官方 CLI",
  douyin_api: "抖音官方 API",
};

export const STATE_LABELS: Record<string, string> = {
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

export const PUBLICATION_LABELS: Record<string, string> = {
  unverified: "公开状态未确认",
  under_review: "审核中",
  published: "已公开",
  rejected: "被拒绝",
  unknown: "未知",
};

export const CONTENT_STATUS_LABELS: Record<string, string> = {
  draft: "草稿",
  ready_for_review: "待审核",
  approved: "已审核",
  superseded: "已替代",
  rejected: "已否决",
};

export const SOURCE_KIND_LABELS: Record<string, string> = {
  brand: "品牌",
  product: "产品",
  case: "案例",
  policy: "规则",
};

/** UTC ISO → 北京时间显示 */
export function fmtTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}

/** datetime-local 输入值（北京时区） */
export function toLocalInput(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  const pad = (n: number) => String(n).padStart(2, "0");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/** datetime-local 值（视为北京时间）→ UTC ISO */
export function fromLocalInput(value: string): string {
  return new Date(`${value}:00+08:00`).toISOString();
}
