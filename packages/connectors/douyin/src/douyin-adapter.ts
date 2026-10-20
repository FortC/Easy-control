import type {
  AdapterCapability,
  AdapterContext,
  AdapterReconcileResult,
  AdapterSubmitResult,
  AdapterVerifyResult,
  PlatformAdapter,
} from "@aipeople/contracts";

/**
 * 抖音官方开放平台 API 适配器（方案 §2：官方 API，由后台 Worker 调用，不在桌面端内嵌 App Secret）。
 *
 * 状态：UNVERIFIED —— 接口路径按开放平台文档类别实现（R5），
 * 实际字段须以应用后台获批 scope 后的文档核对。未配置应用凭据时返回 not_configured。
 * 每次代发必须让用户明确感知（逐次确认由审批流程保证，方案 §3.1）。
 */

export interface DouyinAppConfig {
  clientKey: string;
  clientSecret: string;
  /** 开放平台 API 地址。 */
  baseUrl?: string;
}

const DEFAULT_BASE = "https://open.douyin.com";

export function buildOAuthUrl(config: DouyinAppConfig, redirectUri: string, state: string): string {
  const url = new URL(`${config.baseUrl ?? DEFAULT_BASE}/platform/oauth/connect`);
  url.searchParams.set("client_key", config.clientKey);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "user_info,video.create,video.list");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

/** OAuth 授权码换令牌。返回值须进入后台密钥存储，不得下发到桌面端。 */
export async function exchangeOAuthCode(
  config: DouyinAppConfig,
  code: string,
): Promise<{ ok: true; accessToken: string; openId: string; expiresInSeconds?: number; raw: unknown } | { ok: false; message: string; raw?: unknown }> {
  try {
    const res = await fetch(`${config.baseUrl ?? DEFAULT_BASE}/oauth/access_token/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_key: config.clientKey,
        client_secret: config.clientSecret,
        code,
        grant_type: "authorization_code",
      }),
    });
    const data = (await res.json()) as {
      data?: { access_token?: string; open_id?: string; expires_in?: number; error_code?: number; description?: string };
    };
    const token = data.data?.access_token;
    const openId = data.data?.open_id;
    if (!token || !openId) {
      return { ok: false, message: `抖音令牌交换失败：${data.data?.description ?? res.status}`, raw: data };
    }
    return { ok: true, accessToken: token, openId, expiresInSeconds: data.data?.expires_in, raw: data };
  } catch (error) {
    return { ok: false, message: `抖音令牌交换网络错误：${String(error)}` };
  }
}

export class DouyinAdapter implements PlatformAdapter {
  readonly channel = "douyin_api" as const;

  /** 应用级配置（后台环境变量）；账号级 OAuth 令牌走 resolveSecret。 */
  constructor(private config: DouyinAppConfig | null) {}

  capabilities(): AdapterCapability[] {
    const configured = this.config !== null && this.config.clientKey.length > 0;
    return [
      {
        action: "publish_video",
        available: true,
        notes: configured ? "UNVERIFIED：需应用获批 video.create 权限并完成账号 OAuth" : "未配置应用凭据（DOUYIN_CLIENT_KEY/SECRET）",
      },
      { action: "publish_post", available: false, notes: "图文接口与视频同属 video.create，待应用获批后启用" },
      { action: "pull_metrics", available: false, notes: "数据接口需单独申请权限" },
    ];
  }

  async verifyAccount(ctx: AdapterContext): Promise<AdapterVerifyResult> {
    const secret = await ctx.resolveSecret();
    const token = secret?.["access_token"];
    const openId = secret?.["open_id"];
    if (!token || !openId) {
      return { ok: false, errorCode: "not_configured", errorMessage: "账号未完成抖音 OAuth 授权" };
    }
    if (openId !== ctx.envelope.accountUid) {
      return { ok: false, errorCode: "account_mismatch", errorMessage: `令牌 open_id 与登记账号不符（${openId}）` };
    }
    return { ok: true, uid: openId };
  }

  async submit(ctx: AdapterContext): Promise<AdapterSubmitResult> {
    if (!this.config) {
      return { outcome: "failed", errorCode: "not_configured", errorMessage: "后台未配置抖音应用凭据" };
    }
    const secret = await ctx.resolveSecret();
    const token = secret?.["access_token"];
    const openId = secret?.["open_id"];
    if (!token || !openId) {
      return { outcome: "failed", errorCode: "not_configured", errorMessage: "账号未完成抖音 OAuth 授权" };
    }
    const videoPath = ctx.envelope.content.assetPaths[0];
    if (!videoPath) {
      return { outcome: "failed", errorCode: "internal", errorMessage: "抖音发布需要视频素材" };
    }
    ctx.log("douyin: UNVERIFIED 路径——上传分片与创建接口须按应用后台文档核对后启用");
    // 完整实现（分片上传 video/upload + 创建 video/create）在应用获批后按当时文档接入；
    // 骨架期不伪造请求，避免向未验证端点发送用户内容。
    return {
      outcome: "failed",
      errorCode: "not_configured",
      errorMessage: "抖音发布通道待应用获批后启用（接口字段以应用后台文档为准）",
    };
  }

  async reconcile(_ctx: AdapterContext, _externalId: string): Promise<AdapterReconcileResult> {
    return { publicationStatus: "unverified" };
  }
}
