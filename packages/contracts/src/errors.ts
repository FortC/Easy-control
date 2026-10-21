/**
 * 适配器统一错误码。所有平台连接器把上游错误映射到这里，
 * 调度侧再根据错误码决定状态迁移与是否熔断（方案 §5.3、§12）。
 */
export const ADAPTER_ERROR_CODES = [
  "needs_verify", // 验证码 / 风控拦截 → NEEDS_HUMAN 并暂停账号外发
  "session_expired", // 会话失效 → 暂停账号，等待重连
  "no_permission", // 账号/应用无该接口权限
  "rate_limited", // 平台限流
  "ip_blocked", // IP 被封锁
  "sign_failed", // 请求签名失败（上游接口变化）
  "missing_declaration", // 平台声明能力无法满足
  "not_configured", // 通道未配置（CLI 未安装、应用凭据缺失等）
  "account_mismatch", // 连接的账号 UID 与任务账号不符
  "platform_error", // 平台返回的其他业务错误
  "network", // 网络错误（可安全重试）
  "internal", // 适配器内部错误
] as const;

export type AdapterErrorCode = (typeof ADAPTER_ERROR_CODES)[number];

export const ADAPTER_ERROR_LABELS: Record<AdapterErrorCode, string> = {
  needs_verify: "平台要求验证（验证码/风控）",
  session_expired: "会话失效，需要重新连接账号",
  no_permission: "账号或应用没有该操作权限",
  rate_limited: "平台限流",
  ip_blocked: "IP 被平台封锁",
  sign_failed: "请求签名失败（上游接口可能变化）",
  missing_declaration: "通道无法满足内容所需的平台声明",
  not_configured: "通道未安装或未配置",
  account_mismatch: "账号不匹配",
  platform_error: "平台业务错误",
  network: "网络错误",
  internal: "内部错误",
};

export class AdapterError extends Error {
  constructor(
    public readonly code: AdapterErrorCode,
    message: string,
    public readonly raw?: unknown,
  ) {
    super(message);
    this.name = "AdapterError";
  }
}

/** Runner 上报的执行结果类型（POST /runner-results）。 */
export const RUNNER_OUTCOMES = ["submitted", "failed", "needs_human", "unknown"] as const;
export type RunnerOutcome = (typeof RUNNER_OUTCOMES)[number];
