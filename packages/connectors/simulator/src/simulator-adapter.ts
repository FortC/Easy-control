import { randomUUID } from "node:crypto";
import type {
  AdapterCapability,
  AdapterContext,
  AdapterReconcileResult,
  AdapterSubmitResult,
  AdapterVerifyResult,
  PlatformAdapter,
} from "@aipeople/contracts";

/**
 * 模拟器通道：用于在没有任何平台凭据的情况下演示与测试完整闭环。
 * 行为可通过信封 scenario 字段注入：
 *   ok（默认）/ captcha（验证码拦截）/ unknown（提交后响应丢失）/ fail（提交前失败）/ slow（延迟成功）
 * 模拟“平台审核”由 Worker 的 simulator review 定时器推进（SUBMITTED → UNDER_REVIEW → PUBLISHED）。
 */
export class SimulatorAdapter implements PlatformAdapter {
  readonly channel = "simulator" as const;

  capabilities(): AdapterCapability[] {
    return [
      { action: "publish_image_note", available: true, notes: "模拟发布" },
      { action: "publish_post", available: true, notes: "模拟发布" },
      { action: "publish_video", available: true, notes: "模拟发布" },
      { action: "reply_comment", available: false, notes: "首期不做自动互动" },
      { action: "pull_metrics", available: true, notes: "返回模拟数据" },
    ];
  }

  async verifyAccount(ctx: AdapterContext): Promise<AdapterVerifyResult> {
    ctx.log("simulator: 校验账号", { uid: ctx.envelope.accountUid });
    return { ok: true, uid: ctx.envelope.accountUid, displayName: `模拟账号 ${ctx.envelope.accountUid}` };
  }

  async submit(ctx: AdapterContext): Promise<AdapterSubmitResult> {
    const scenario = ctx.envelope.scenario ?? "ok";
    const { platform, content, accountUid } = ctx.envelope;
    ctx.log("simulator: 提交", { scenario, platform, title: content.title });

    if (scenario === "captcha") {
      return {
        outcome: "needs_human",
        errorCode: "needs_verify",
        errorMessage: "模拟平台拦截：要求验证码（NEEDS_HUMAN，账号外发已暂停）",
      };
    }
    if (scenario === "fail") {
      return {
        outcome: "failed",
        errorCode: "platform_error",
        errorMessage: "模拟平台业务错误：内容不符合规范",
      };
    }
    if (scenario === "slow") {
      await sleep(3000);
    }

    const externalId = `sim_${platform}_${randomUUID().slice(0, 8)}`;
    const submitted = {
      note_id: externalId,
      platform,
      uid: accountUid,
      title: content.title,
      body_length: content.body.length,
      declared_ai: content.declarations.aiGenerated,
    };

    if (scenario === "unknown") {
      // 模拟提交已发出但响应丢失：必须返回 unknown，由对账流程处理
      return {
        outcome: "unknown",
        errorCode: null,
        errorMessage: "模拟场景：提交已发出但未收到平台回执（UNKNOWN，进入对账）",
        raw: submitted,
      };
    }

    return {
      outcome: "submitted",
      externalId,
      url: `https://sim.aipeople.local/${platform}/${externalId}`,
      raw: submitted,
    };
  }

  async reconcile(ctx: AdapterContext, externalId: string): Promise<AdapterReconcileResult> {
    ctx.log("simulator: 对账", { externalId });
    // 模拟平台可回读：提交 8 秒后视为已公开
    return { publicationStatus: "published", url: `https://sim.aipeople.local/${ctx.envelope.platform}/${externalId}` };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
