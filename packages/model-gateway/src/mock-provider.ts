import { createHash } from "node:crypto";
import type { Platform } from "@aipeople/contracts";
import type { GenerateDraftRequest, GeneratedDraft, ModelProviderAdapter, ProviderUsage } from "./types.js";

/**
 * 内置 Mock 供应商：不调用外部模型，基于真实资料与目标用模板生成草稿。
 * 用于无密钥环境下演示完整闭环；内容里的断言全部来自资料摘录，不虚构事实。
 */

function stableIndex(seed: string, mod: number): number {
  const hash = createHash("sha256").update(seed, "utf8").digest();
  return hash.readUInt32BE(0) % mod;
}

function pick<T>(seed: string, items: readonly T[]): T {
  return items[stableIndex(seed, items.length)]!;
}

function goalKeywords(goal: string): string[] {
  return goal
    .split(/[\s，。！？、；：,.!?;:]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .slice(0, 4);
}

const AI_DECLARATION = "本文由 AI 辅助整理，内容基于品牌方提供的真实资料，已由运营人工核实。";

export class MockProvider implements ModelProviderAdapter {
  readonly adapterId = "mock" as const;

  async generateDraft(req: GenerateDraftRequest): Promise<{ draft: GeneratedDraft; usage: ProviderUsage }> {
    const { goal, platform, sources } = req;
    const seed = `${goal}|${platform}`;
    const keywords = goalKeywords(goal);
    const mainKeyword = keywords[0] ?? "新品";
    const sourcePoints = sources.slice(0, 3).map((s) => `· ${s.title}：${s.excerpt}`);
    const warnings: string[] = [];
    for (const s of sources) {
      if (s.expiresAt && new Date(s.expiresAt).getTime() < Date.now() + 7 * 86_400_000) {
        warnings.push(`资料《${s.title}》即将过期或已过期，发布前请复核其中价格/参数`);
      }
    }

    const parts: string[] = [];
    if (platform === "xiaohongshu") {
      const hooks = [
        "最近把这件事彻底整理了一遍",
        "被问了很多次，这次一次性说清楚",
        "根据现有资料，把关键内容整理在这里",
      ];
      parts.push(
        [
          `${pick(seed, hooks)}，关于${mainKeyword}，直接上干货。`,
          "",
          ...sourcePoints,
          "",
          `整理这些的时候用的是品牌方提供的真实资料（${sources.length} 份），没有编造的部分；有存疑的地方欢迎评论区指出。`,
          "",
          `你最关心${mainKeyword}的哪一点？评论区告诉我，下一篇整理给你。`,
          "",
          `${AI_DECLARATION}`,
        ].join("\n"),
      );
    } else if (platform === "weibo") {
      const summary = sourcePoints.length > 0 ? sourcePoints[0]!.replace(/^· /, "") : `${mainKeyword}资料整理`;
      parts.push(
        [
          `${mainKeyword}要点整理：${summary}`,
          `已核对品牌方提供的真实资料（${sources.length} 份），细节见图。`,
          `你最关心哪一点？评论区聊聊👇`,
          "",
          `${AI_DECLARATION}`,
        ].join("\n"),
      );
    } else if (platform === 'zhihu') {
      parts.push([`${mainKeyword}：基于现有资料的分析`, '', ...sourcePoints, '', '以上为资料整理示例，请补充可验证的论据后审核发布。', '', AI_DECLARATION].join('\n'));
    } else {
      parts.push(
        [
          `【口播脚本】`,
          `开场：今天用 30 秒讲清楚${mainKeyword}。`,
          ...sourcePoints.map((p, i) => `要点${i + 1}：${p.replace(/^· /, "")}`),
          `结尾：完整资料我放在评论区，想看哪部分细节留言。`,
          "",
          `【拍摄提示】要点逐条出字幕卡；资料页出镜截图需带品牌授权说明。`,
          "",
          AI_DECLARATION,
        ].join("\n"),
      );
    }

    const topicsByPlatform: Record<Platform, string[]> = {
      xiaohongshu: [mainKeyword, "干货整理", "真实体验"],
      weibo: [mainKeyword, "资料整理"],
      douyin: [mainKeyword, "干货分享"],
      zhihu: [mainKeyword,'资料分析'],
    };

    const draft: GeneratedDraft = {
      title:
        platform === "weibo"
          ? `${mainKeyword}要点`
          : `${mainKeyword}${pick(seed + "t", ["完整整理", "一次说清", "干货清单"])}`,
      body: parts.join(""),
      topics: topicsByPlatform[platform],
      declarations: { aiGenerated: true, commercial: false },
      aiDeclarationText: AI_DECLARATION,
      citations: sources.slice(0, 3).map((s) => ({
        sourceId: s.id,
        sourceTitle: s.title,
        quote: s.excerpt.slice(0, 120),
      })),
      warnings,
    };

    const usage: ProviderUsage = {
      inputTokens: 400 + sources.length * 120,
      outputTokens: 300,
    };
    return { draft, usage };
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    return { ok: true, message: "Mock 供应商无需网络，始终可用" };
  }
}
