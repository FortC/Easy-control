import { z } from "zod";
import { createHash } from "node:crypto";
import { ACTIONS, CHANNELS, PLATFORMS, type Action, type Channel, type Platform } from "./platforms.js";
import { RUNNER_OUTCOMES } from "./errors.js";

/**
 * 任务信封：调度服务发放给执行器的结构化动作（方案 §7）。
 * Runner 领取后必须校验设备、工作空间、账号与内容摘要，不接受任意服务器字符串作为本机命令。
 */
export const TaskEnvelopeSchema = z.object({
  taskId: z.string().min(1),
  attemptId: z.string().min(1),
  workspaceId: z.string().min(1),
  platform: z.enum(PLATFORMS),
  channel: z.enum(CHANNELS),
  accountId: z.string().min(1),
  accountUid: z.string().min(1),
  action: z.enum(ACTIONS),
  contentVersionId: z.string().min(1),
  contentHash: z.string().min(8),
  approvalId: z.string().min(1),
  scheduledAt: z.string(),
  expiresAt: z.string(),
  timezone: z.string().default("Asia/Shanghai"),
  runnerId: z.string().min(1),
  /** 模拟器场景注入：ok / captcha / unknown / fail（仅 simulator 通道使用）。 */
  scenario: z.string().optional(),
  content: z.object({
    title: z.string(),
    body: z.string(),
    topics: z.array(z.string()).default([]),
    assetPaths: z.array(z.string()).default([]),
    declarations: z
      .object({
        aiGenerated: z.boolean().default(false),
        commercial: z.boolean().default(false),
      })
      .default({ aiGenerated: false, commercial: false }),
    aiDeclarationText: z.string().optional(),
  }),
});

export type TaskEnvelope = z.infer<typeof TaskEnvelopeSchema>;

/** Runner 执行结果上报。 */
export const RunnerResultSchema = z.object({
  taskId: z.string(),
  attemptId: z.string(),
  outcome: z.enum(RUNNER_OUTCOMES),
  externalId: z.string().nullish(),
  url: z.string().nullish(),
  errorCode: z.string().nullish(),
  errorMessage: z.string().nullish(),
  raw: z.unknown().optional(),
  finishedAt: z.string(),
});

export type RunnerResult = z.infer<typeof RunnerResultSchema>;

/** 内容载荷的规范哈希：标题+正文+话题+素材清单+声明（审批绑定用，方案 §9.1）。 */
export function computeContentHash(input: {
  title: string;
  body: string;
  topics: string[];
  assetIds: string[];
  declarations: { aiGenerated: boolean; commercial: boolean };
}): string {
  const canonical = JSON.stringify({
    title: input.title,
    body: input.body,
    topics: [...input.topics].sort(),
    assetIds: [...input.assetIds].sort(),
    declarations: input.declarations,
  });
  return "sha256:" + createHash("sha256").update(canonical, "utf8").digest("hex");
}

export interface EnvelopeBinding {
  workspaceId: string;
  runnerId: string;
  accountId: string;
}

/** Runner 侧二次校验：信封必须与本地登记的绑定一致（方案 §4.3）。 */
export function verifyEnvelopeBinding(
  envelope: TaskEnvelope,
  expected: { runnerId: string; workspaceId: string; accountIds: readonly string[] },
): { ok: true } | { ok: false; reason: string } {
  if (envelope.runnerId !== expected.runnerId) {
    return { ok: false, reason: `信封 runnerId 不属于本设备（${envelope.runnerId}）` };
  }
  if (envelope.workspaceId !== expected.workspaceId) {
    return { ok: false, reason: `信封 workspaceId 与本设备绑定不符（${envelope.workspaceId}）` };
  }
  if (!expected.accountIds.includes(envelope.accountId)) {
    return { ok: false, reason: `信封 accountId 未在本设备登记（${envelope.accountId}）` };
  }
  return { ok: true };
}
