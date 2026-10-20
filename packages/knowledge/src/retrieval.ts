import type { Citation } from "@aipeople/contracts";

export type SourceKind = "brand" | "product" | "case" | "policy";

export interface SourceRecord {
  id: string;
  workspaceId: string;
  kind: SourceKind;
  title: string;
  content: string;
  copyright?: string | null;
  licenseScope?: string | null;
  owner?: string | null;
  /** 易变信息（价格、参数等）的有效期；过期后生成内容必须提示复核。 */
  expiresAt?: string | null;
  createdAt: string;
}

/** 提取中英文关键词（简单分词：按标点/空白切分，保留 ≥2 字符词）。 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s，。！？、；：,.!?;:（）()【】\[\]""''"\n\r\t]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

/**
 * 简单相关性检索：关键词重叠计分。资料量大时再升级为全文检索/向量（方案 §7），
 * 接口保持不变。
 */
export function retrieveRelevantSources(
  sources: SourceRecord[],
  query: string,
  limit = 5,
): { source: SourceRecord; score: number }[] {
  const queryTokens = new Set(tokenize(query));
  const scored = sources
    .filter((s) => !s.expiresAt || new Date(s.expiresAt).getTime() > Date.now())
    .map((source) => {
      const tokens = tokenize(`${source.title} ${source.content}`);
      let score = 0;
      for (const token of tokens) if (queryTokens.has(token)) score += 1;
      if (source.kind === "brand") score += 0.5; // 品牌资料优先
      return { source, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  if (scored.length === 0 && sources.length > 0) {
    // 没有命中时退回前几条，保证生成总能引用真实资料
    return sources.slice(0, Math.min(limit, 3)).map((source) => ({ source, score: 0 }));
  }
  return scored;
}

export function buildCitations(entries: { source: SourceRecord; quote: string }[]): Citation[] {
  return entries.map(({ source, quote }) => ({
    sourceId: source.id,
    sourceTitle: source.title,
    quote: quote.slice(0, 120),
  }));
}

export function excerpt(source: SourceRecord, maxLen = 160): string {
  return source.content.length > maxLen ? `${source.content.slice(0, maxLen)}…` : source.content;
}
