import type { Action, Channel } from "./platforms.js";
import type { AdapterErrorCode } from "./errors.js";
import type { TaskEnvelope } from "./envelope.js";
import type { PublicationStatus } from "./task-states.js";

/** 适配器执行上下文：由 Runner（或后台 Worker）构造。 */
export interface AdapterContext {
  envelope: TaskEnvelope;
  /** 解析账号凭据（如小红书 Cookie），仅在适配器进程内使用，禁止进入日志与模型上下文。 */
  resolveSecret(): Promise<Record<string, string> | null>;
  log(message: string, detail?: unknown): void;
}

export interface AdapterSubmitResult {
  outcome: "submitted" | "failed" | "needs_human" | "unknown";
  externalId?: string | null;
  url?: string | null;
  errorCode?: AdapterErrorCode | null;
  errorMessage?: string | null;
  raw?: unknown;
}

export interface AdapterVerifyResult {
  ok: boolean;
  uid?: string;
  displayName?: string;
  errorCode?: AdapterErrorCode;
  errorMessage?: string;
}

export interface AdapterReconcileResult {
  publicationStatus: PublicationStatus;
  url?: string | null;
  raw?: unknown;
}

export interface AdapterCapability {
  action: Action;
  available: boolean;
  notes?: string;
}

/**
 * 平台适配器统一接口（方案 §6：prepare / validate / preview / submit / reconcile / metrics
 * 的最小集合；不要求每个平台实现全部方法）。
 */
export interface PlatformAdapter {
  readonly channel: Channel;
  capabilities(): AdapterCapability[];
  /** 校验账号连接（会话有效性、UID 一致）。 */
  verifyAccount(ctx: AdapterContext): Promise<AdapterVerifyResult>;
  /** 提交外发动作。实现必须保证：抛错时动作未提交，或显式返回 unknown。 */
  submit(ctx: AdapterContext): Promise<AdapterSubmitResult>;
  /** 核实已提交内容的公开状态。 */
  reconcile?(ctx: AdapterContext, externalId: string): Promise<AdapterReconcileResult>;
}
