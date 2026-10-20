import { describe, expect, it } from "vitest";
import { preflightCheck, type PreflightInput } from "./preflight.js";

function baseInput(overrides: Partial<PreflightInput> = {}): PreflightInput {
  const now = new Date("2026-10-21T10:00:00+08:00");
  return {
    now,
    task: {
      accountId: "acc_001",
      platform: "xiaohongshu",
      channel: "simulator",
      action: "publish_image_note",
      contentHash: "sha256:aaa",
      approvalId: "apr_001",
      scheduledAt: now,
      expiresAt: new Date(now.getTime() + 30 * 60_000),
    },
    account: {
      id: "acc_001",
      platform: "xiaohongshu",
      channel: "simulator",
      paused: false,
      pausedReason: null,
      sessionStatus: "active",
      grantedActions: ["publish_image_note"],
    },
    contentVersion: {
      id: "cv_001",
      hash: "sha256:aaa",
      status: "approved",
      declarations: { aiGenerated: true, commercial: false },
    },
    approval: {
      id: "apr_001",
      status: "active",
      contentHash: "sha256:aaa",
      accountId: "acc_001",
      action: "publish_image_note",
      expiresAt: new Date(now.getTime() + 60_000),
    },
    workspace: { aigcPolicy: "strict", dailyBudgetCny: 100 },
    accountInFlight: 0,
    spentTodayCny: 0,
    channelCapabilities: [{ action: "publish_image_note", available: true }],
    ...overrides,
  };
}

/** 断言被拒绝并返回拒绝原因。 */
function expectDenied(input: PreflightInput): string {
  const decision = preflightCheck(input);
  expect(decision.allowed).toBe(false);
  if (!decision.allowed) return decision.reason;
  throw new Error("不应放行");
}

describe("发布前检查", () => {
  it("各项正常时放行", () => {
    expect(preflightCheck(baseInput())).toEqual({ allowed: true });
  });

  it("审批哈希与内容不符时拒绝", () => {
    const input = baseInput();
    input.contentVersion = { ...input.contentVersion, hash: "sha256:bbb" };
    expect(expectDenied(input)).toBe("approval_hash_mismatch");
  });

  it("审批过期、缺失、账号不符分别拒绝", () => {
    const expired = baseInput();
    expired.approval = { ...expired.approval!, expiresAt: new Date("2026-10-20T00:00:00Z") };
    expect(expectDenied(expired)).toBe("approval_expired");

    expect(expectDenied(baseInput({ approval: null }))).toBe("approval_missing");

    const wrongAccount = baseInput();
    wrongAccount.approval = { ...wrongAccount.approval!, accountId: "acc_002" };
    expect(expectDenied(wrongAccount)).toBe("approval_account_mismatch");
  });

  it("账号暂停、会话失效、未决任务互斥", () => {
    const paused = baseInput();
    paused.account = { ...paused.account, paused: true, pausedReason: "验证码待处理" };
    expect(expectDenied(paused)).toBe("account_paused");

    const expiredSession = baseInput();
    expiredSession.account = { ...expiredSession.account, sessionStatus: "expired" };
    expect(expectDenied(expiredSession)).toBe("session_expired");

    expect(expectDenied(baseInput({ accountInFlight: 1 }))).toBe("account_busy");
  });

  it("执行窗口过期与预算超限", () => {
    expect(expectDenied(baseInput({ now: new Date("2026-10-21T11:00:00+08:00") }))).toBe("window_expired");
    expect(expectDenied(baseInput({ spentTodayCny: 120 }))).toBe("budget_exceeded");
  });

  it("AIGC 声明：strict 下 redbook 通道转人工，in_text 放行", () => {
    const redbook = baseInput();
    redbook.task = { ...redbook.task, channel: "redbook" };
    redbook.account = { ...redbook.account, channel: "redbook" };
    expect(expectDenied(redbook)).toBe("aigc_declaration_unsupported");

    const inText = baseInput();
    inText.workspace = { ...inText.workspace, aigcPolicy: "in_text" };
    inText.task = { ...inText.task, channel: "redbook" };
    inText.account = { ...inText.account, channel: "redbook" };
    expect(preflightCheck(inText).allowed).toBe(true);
  });
});
