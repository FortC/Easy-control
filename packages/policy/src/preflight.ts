import type { Action, Channel, Platform } from "@aipeople/contracts";

/**
 * 发布前检查（PREFLIGHT）的输入。所有字段由调用方从数据库与适配器能力登记中取出，
 * 本模块保持纯函数，便于单测覆盖（方案 §9.1 校验清单、§6 四层授权）。
 */
export interface PreflightInput {
  now: Date;
  task: {
    accountId: string;
    platform: Platform;
    channel: Channel;
    action: Action;
    contentHash: string;
    approvalId: string;
    scheduledAt: Date;
    expiresAt: Date;
  };
  account: {
    id: string;
    platform: Platform;
    channel: Channel;
    paused: boolean;
    pausedReason?: string | null;
    sessionStatus: "active" | "expired" | "unknown";
    grantedActions: string[];
  };
  contentVersion: {
    id: string;
    hash: string;
    status: string;
    declarations: { aiGenerated: boolean; commercial: boolean };
  };
  approval: {
    id: string;
    status: string;
    contentHash: string;
    accountId: string;
    action: Action;
    expiresAt: Date;
  } | null;
  workspace: {
    /** strict：通道不支持平台 AIGC 声明时转人工；in_text：正文声明即可；off：不检查。 */
    aigcPolicy: "strict" | "in_text" | "off";
    dailyBudgetCny: number | null;
  };
  /** 该账号当前未决（RUNNING/SUBMITTED/UNKNOWN）任务数。 */
  accountInFlight: number;
  spentTodayCny: number;
  /** 适配器声明的通道能力（action → 是否可用）。 */
  channelCapabilities: { action: string; available: boolean; notes?: string }[];
}

export type PolicyDenyReason =
  | "approval_missing"
  | "approval_invalid"
  | "approval_hash_mismatch"
  | "approval_expired"
  | "approval_account_mismatch"
  | "content_modified"
  | "account_paused"
  | "session_expired"
  | "capability_unavailable"
  | "account_busy"
  | "window_expired"
  | "budget_exceeded"
  | "aigc_declaration_unsupported";

export type PolicyDecision = { allowed: true } | { allowed: false; reason: PolicyDenyReason; detail: string };

export const POLICY_DENY_LABELS: Record<PolicyDenyReason, string> = {
  approval_missing: "缺少有效审批",
  approval_invalid: "审批已失效",
  approval_hash_mismatch: "审批与内容版本不匹配",
  approval_expired: "审批已过期",
  approval_account_mismatch: "审批绑定的账号与任务不符",
  content_modified: "内容在审批后被修改，需要重新审核",
  account_paused: "账号已暂停外发",
  session_expired: "账号会话失效，需要重新连接",
  capability_unavailable: "通道不具备该操作能力",
  account_busy: "该账号存在未确认的提交，暂缓后续写入",
  window_expired: "已超过执行窗口",
  budget_exceeded: "超出当日预算",
  aigc_declaration_unsupported: "通道无法满足 AI 生成声明要求，转人工发布",
};

export function preflightCheck(input: PreflightInput): PolicyDecision {
  const { task, account, contentVersion, approval, workspace, now } = input;

  if (now.getTime() > task.expiresAt.getTime()) {
    return deny("window_expired", `执行窗口已于 ${task.expiresAt.toISOString()} 过期`);
  }
  if (!approval) return deny("approval_missing", "任务没有绑定有效审批");
  if (approval.id !== task.approvalId) return deny("approval_invalid", "审批 ID 与任务不一致");
  if (approval.status !== "active") return deny("approval_invalid", `审批状态为 ${approval.status}`);
  if (approval.accountId !== task.accountId) {
    return deny("approval_account_mismatch", "审批绑定的账号与任务账号不符");
  }
  if (approval.action !== task.action) {
    return deny("approval_invalid", "审批动作与任务动作不符");
  }
  if (now.getTime() > approval.expiresAt.getTime()) {
    return deny("approval_expired", `审批已于 ${approval.expiresAt.toISOString()} 过期`);
  }
  if (approval.contentHash !== task.contentHash || task.contentHash !== contentVersion.hash) {
    return deny("approval_hash_mismatch", "审批内容哈希与当前内容版本不一致");
  }
  if (contentVersion.hash !== contentVersion.hash || contentVersion.status === "superseded") {
    return deny("content_modified", "内容版本已被替换");
  }
  if (account.paused) {
    return deny("account_paused", account.pausedReason ?? "账号已暂停");
  }
  if (account.platform !== task.platform || account.channel !== task.channel) {
    return deny("capability_unavailable", "账号通道与任务通道不一致");
  }
  if (account.sessionStatus === "expired") {
    return deny("session_expired", "账号会话已失效");
  }
  if (!account.grantedActions.includes(task.action)) {
    return deny("capability_unavailable", `账号未授权动作 ${task.action}`);
  }
  const cap = input.channelCapabilities.find((c) => c.action === task.action);
  if (!cap || !cap.available) {
    return deny("capability_unavailable", cap?.notes ?? `通道 ${task.channel} 不支持 ${task.action}`);
  }
  if (input.accountInFlight > 0) {
    return deny("account_busy", "同账号存在提交结果未明的任务，暂缓写入");
  }
  if (workspace.dailyBudgetCny !== null && input.spentTodayCny >= workspace.dailyBudgetCny) {
    return deny("budget_exceeded", `当日已花费 ¥${input.spentTodayCny.toFixed(2)}，超出预算`);
  }
  const aigc = checkAigcDeclaration(input);
  if (!aigc.allowed) return aigc;

  return { allowed: true };
}

/** 检查平台通道是否支持声明 AI 生成属性。 */
export function checkAigcDeclaration(input: PreflightInput): PolicyDecision {
  const { workspace, contentVersion, task } = input;
  if (workspace.aigcPolicy === "off") return { allowed: true };
  if (!contentVersion.declarations.aiGenerated) return { allowed: true };
  if (workspace.aigcPolicy === "in_text") return { allowed: true };
  const channelDeclaresAigc = task.channel === "simulator" || task.channel === "weibo_cli" || task.channel === "douyin_api";
  if (!channelDeclaresAigc) {
    return deny(
      "aigc_declaration_unsupported",
      `通道 ${task.channel} 暂不支持平台级 AI 生成声明，请在官方工具人工发布`,
    );
  }
  return { allowed: true };
}

function deny(reason: PolicyDenyReason, detail: string): PolicyDecision {
  return { allowed: false, reason, detail };
}
