import { z } from "zod";
import { PLATFORMS, ACTIONS } from "./platforms.js";

/** 内容版本（方案 §11 ContentVersion）。 */
export const CONTENT_VERSION_STATUSES = [
  "draft",
  "ready_for_review",
  "approved",
  "superseded",
  "rejected",
] as const;
export type ContentVersionStatus = (typeof CONTENT_VERSION_STATUSES)[number];

export const CONTENT_VERSION_STATUS_LABELS: Record<ContentVersionStatus, string> = {
  draft: "草稿",
  ready_for_review: "待审核",
  approved: "已审核",
  superseded: "已被新版本替代",
  rejected: "已否决",
};

export interface Citation {
  sourceId: string;
  sourceTitle: string;
  quote: string;
}

export interface ContentDeclarations {
  aiGenerated: boolean;
  commercial: boolean;
  /** 建议写进正文的 AI 参与声明文案（如“本文由 AI 辅助整理”）。 */
  aiDeclarationText?: string;
}

export interface ContentVersion {
  id: string;
  workspaceId: string;
  platform: (typeof PLATFORMS)[number];
  title: string;
  body: string;
  topics: string[];
  assetIds: string[];
  declarations: ContentDeclarations;
  citations: Citation[];
  modelInfo: { provider: string; model: string } | null;
  status: ContentVersionStatus;
  hash: string;
  createdBy: string;
  createdAt: string;
}

export const APPROVAL_STATUSES = ["active", "expired", "consumed", "invalidated"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export interface Approval {
  id: string;
  workspaceId: string;
  contentVersionId: string;
  platform: (typeof PLATFORMS)[number];
  accountId: string;
  action: (typeof ACTIONS)[number];
  contentHash: string;
  assetHashes: string[];
  status: ApprovalStatus;
  approvedBy: string;
  approvedAt: string;
  expiresAt: string;
}

/** 审批创建请求。 */
export const ApproveRequestSchema = z.object({
  accountId: z.string().min(1),
  action: z.enum(ACTIONS),
  validMinutes: z.number().int().min(1).max(60 * 24 * 30).default(24 * 60),
});
