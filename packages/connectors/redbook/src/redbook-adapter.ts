import type {
  AdapterCapability,
  AdapterContext,
  AdapterErrorCode,
  AdapterReconcileResult,
  AdapterSubmitResult,
  AdapterVerifyResult,
  PlatformAdapter,
} from "@aipeople/contracts";
import type { XhsClient, XhsCookies } from "@lucasygu/redbook";

/**
 * 小红书 redbook 实验适配器（第三方通道，固定上游 0.8.2，进程内调用官方导出的客户端封装）。
 *
 * 状态：UNVERIFIED —— 代码按源码审查快照实现，尚未用真实账号验证；
 * 平台拦截（验证码/风控）一律转 NEEDS_HUMAN 并暂停账号外发，不做绕过。
 *
 * 明确不使用：batch-reply、自动收藏、批量互动、反检测节奏（方案 §3）。
 * 已知限制：上游无平台级 AIGC 声明参数 → 声明策略由 policy 在发布前检查。
 */

export interface UpstreamErrorShape {
  name?: string;
  message?: string;
  code?: number;
  status?: number;
}

function mapUpstreamError(error: unknown): { code: AdapterErrorCode; message: string } {
  const err = error as UpstreamErrorShape;
  const status = typeof err?.status === "number" ? err.status : undefined;
  const code = typeof err?.code === "number" ? err.code : undefined;
  const message = err?.message ?? String(error);

  if (err?.name === "NeedVerifyError" || status === 461 || status === 471) {
    return { code: "needs_verify", message: `平台要求验证（status=${status}）：${message}` };
  }
  if (code === -100) return { code: "session_expired", message: `会话过期，需要重新登录：${message}` };
  if (code === -101) return { code: "session_expired", message: `Cookie 缺少 web_session：${message}` };
  if (code === -104) return { code: "no_permission", message: `账号无该接口权限：${message}` };
  if (code === 300012) return { code: "ip_blocked", message: `IP 被平台封锁：${message}` };
  if (code === 300015 || status === 406) return { code: "sign_failed", message: `请求签名失败（上游可能需升级）：${message}` };
  if (typeof message === "string" && /fetch failed|network|ECONN|ETIMEDOUT/i.test(message)) {
    return { code: "network", message: `网络错误：${message}` };
  }
  return { code: "platform_error", message };
}

export class RedbookAdapter implements PlatformAdapter {
  readonly channel = "redbook" as const;

  capabilities(): AdapterCapability[] {
    return [
      { action: "publish_image_note", available: true, notes: "UNVERIFIED：上游发布接口实测通过后移除此标注" },
      { action: "pull_metrics", available: false, notes: "受限读取首期仅账号自身信息" },
      { action: "reply_comment", available: false, notes: "首期禁用互动（平台 AI 托管治理风险）" },
    ];
  }

  private async createClient(ctx: AdapterContext): Promise<
    { ok: true; client: XhsClient } | { ok: false; code: AdapterErrorCode; message: string }
  > {
    const secret = await ctx.resolveSecret();
    const a1 = secret?.["a1"];
    const webSession = secret?.["web_session"];
    if (!a1 || !webSession) {
      return { ok: false, code: "not_configured", message: "缺少小红书会话（a1 / web_session），请重新连接账号" };
    }
    const { XhsClient } = await import("@lucasygu/redbook");
    const cookies: XhsCookies = { a1, web_session: webSession, ...(secret["webId"] ? { webId: secret["webId"] } : {}) };
    return { ok: true, client: new XhsClient(cookies, "xhs") };
  }

  async verifyAccount(ctx: AdapterContext): Promise<AdapterVerifyResult> {
    try {
      const created = await this.createClient(ctx);
      if (!created.ok) return { ok: false, errorCode: created.code, errorMessage: created.message };
      const info = await created.client.getSelfInfo();
      const uid = String(info.user_id ?? "");
      if (!uid) return { ok: false, errorCode: "session_expired", errorMessage: "无法读取账号信息，会话可能已失效" };
      if (uid !== ctx.envelope.accountUid) {
        return { ok: false, errorCode: "account_mismatch", errorMessage: `会话账号 ${uid} 与登记账号 ${ctx.envelope.accountUid} 不符` };
      }
      return { ok: true, uid, displayName: String(info.nickname ?? uid) };
    } catch (error) {
      const mapped = mapUpstreamError(error);
      return { ok: false, errorCode: mapped.code, errorMessage: mapped.message };
    }
  }

  async submit(ctx: AdapterContext): Promise<AdapterSubmitResult> {
    const { content } = ctx.envelope;
    if (content.assetPaths.length === 0) {
      return { outcome: "failed", errorCode: "internal", errorMessage: "小红书图文至少需要一张图片素材" };
    }
    let client: XhsClient;
    try {
      const created = await this.createClient(ctx);
      if (!created.ok) {
        return { outcome: "failed", errorCode: created.code, errorMessage: created.message };
      }
      client = created.client;

      // 逐张上传图片（账号内串行，避免并发错误）
      const fileIds: string[] = [];
      for (const imagePath of content.assetPaths) {
        ctx.log("redbook: 申请上传许可", { imagePath });
        const permit = await client.getUploadPermit("image", 1);
        ctx.log("redbook: 上传图片", { imagePath });
        await client.uploadFile(permit.fileId, permit.token, imagePath, contentTypeFor(imagePath));
        fileIds.push(permit.fileId);
      }

      // 话题：逐个搜索取首个匹配；失败不阻塞发布
      const topics: { id: string; name: string }[] = [];
      for (const keyword of content.topics.slice(0, 3)) {
        try {
          const found = await client.searchTopics(keyword);
          if (found && found.length > 0) topics.push(found[0]!);
        } catch (error) {
          ctx.log("redbook: 话题搜索失败，跳过", { keyword, error: String(error) });
        }
      }

      ctx.log("redbook: 创建图文笔记", { title: content.title, images: fileIds.length, topics: topics.length });
      const response = await client.createImageNote(content.title, content.body, fileIds, { topics });

      const noteId = extractString(response, ["note_id", "noteId"]) ?? extractNestedNoteId(response);
      if (!noteId) {
        // 上游返回了成功但没有可核对的 ID：保守标记 unknown，交由对账
        return {
          outcome: "unknown",
          errorMessage: "上游响应中没有 note_id，无法确认提交结果",
          raw: safeJson(response),
        };
      }
      const xsecToken = extractString(response, ["xsec_token"]) ?? undefined;
      const url = xsecToken
        ? `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=${encodeURIComponent(xsecToken)}`
        : `https://www.xiaohongshu.com/explore/${noteId}`;
      return { outcome: "submitted", externalId: noteId, url, raw: safeJson(response) };
    } catch (error) {
      const mapped = mapUpstreamError(error);
      const needsHuman = mapped.code === "needs_verify" || mapped.code === "session_expired" || mapped.code === "ip_blocked";
      return {
        outcome: needsHuman ? "needs_human" : "failed",
        errorCode: mapped.code,
        errorMessage: mapped.message,
      };
    }
  }

  async reconcile(ctx: AdapterContext, externalId: string): Promise<AdapterReconcileResult> {
    try {
      const created = await this.createClient(ctx);
      if (!created.ok) return { publicationStatus: "unknown" };
      const note = await created.client.getNoteById(externalId);
      const status = extractString(note, ["status"]);
      if (status === "normal" || status === "public") {
        return { publicationStatus: "published", url: `https://www.xiaohongshu.com/explore/${externalId}` };
      }
      if (status === "reviewing" || status === "audit") {
        return { publicationStatus: "under_review" };
      }
      if (status === "rejected" || status === "fail") {
        return { publicationStatus: "rejected" };
      }
      return { publicationStatus: "unverified" };
    } catch {
      return { publicationStatus: "unknown" };
    }
  }
}

function contentTypeFor(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

function extractString(obj: unknown, keys: string[]): string | null {
  if (!obj || typeof obj !== "object") return null;
  const record = obj as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number") return String(value);
  }
  return null;
}

function extractNestedNoteId(obj: unknown): string | null {
  if (!obj || typeof obj !== "object") return null;
  for (const value of Object.values(obj as Record<string, unknown>)) {
    if (value && typeof value === "object") {
      const found = extractString(value, ["note_id", "noteId"]);
      if (found) return found;
    }
  }
  return null;
}

function safeJson(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}
