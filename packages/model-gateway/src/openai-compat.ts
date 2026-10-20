import { z } from "zod";
import type { GenerateDraftRequest, GeneratedDraft, ModelProviderAdapter, ProviderUsage } from "./types.js";

const DraftJsonSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  topics: z.array(z.string()).min(1).max(6),
  aiDeclarationText: z.string().default("本文由 AI 辅助整理，内容基于真实资料。"),
  citations: z
    .array(z.object({ sourceId: z.string(), quote: z.string().max(160) }))
    .default([]),
});

export interface OpenAICompatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

/** OpenAI 兼容 /chat/completions 适配（智谱 GLM、DeepSeek、通义、Kimi、OpenAI 等）。 */
export class OpenAICompatProvider implements ModelProviderAdapter {
  readonly adapterId = "openai_compatible" as const;

  constructor(private options: OpenAICompatOptions) {}

  private async chat(messages: { role: string; content: string }[], jsonMode: boolean) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 60_000);
    try {
      const res = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({
          model: this.options.model,
          messages,
          temperature: 0.7,
          ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`模型服务返回 ${res.status}：${text.slice(0, 300)}`);
      }
      return (await res.json()) as {
        choices: { message: { content: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async generateDraft(req: GenerateDraftRequest): Promise<{ draft: GeneratedDraft; usage: ProviderUsage }> {
    const sourceLines = req.sources
      .map((s, i) => `[${i + 1}] id=${s.id} 《${s.title}》 ${s.excerpt}`)
      .join("\n");
    const system = [
      "你是新媒体运营助手，只依据用户提供的真实资料创作，不虚构销量、经历、资质和客户案例。",
      "平台约定：xiaohongshu=图文笔记（口语化、分点、结尾互动），weibo=短博文（140字内、#话题#），douyin=短视频口播脚本。",
      "必须输出 JSON：{title, body, topics, aiDeclarationText, citations:[{sourceId, quote}]}。",
      "citations 引用你实际用到的资料 id 与原文短句；topics 是 2-4 个不带#的话题词。",
    ].join("\n");
    const user = [
      `运营目标：${req.goal}`,
      req.brandTone ? `品牌口吻：${req.brandTone}` : "",
      `目标平台：${req.platform}`,
      req.accountName ? `发布账号：${req.accountName}` : "",
      "可用资料：",
      sourceLines || "（无资料，请直接拒绝并在 body 开头注明“资料不足”）",
    ]
      .filter(Boolean)
      .join("\n");

    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const data = await this.chat(
          [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          true,
        );
        const content = data.choices[0]?.message?.content ?? "";
        const parsed = DraftJsonSchema.parse(JSON.parse(extractJson(content)));
        const sourceTitles = new Map(req.sources.map((s) => [s.id, s.title]));
        const draft: GeneratedDraft = {
          title: parsed.title,
          body: parsed.body,
          topics: parsed.topics,
          declarations: { aiGenerated: true, commercial: false },
          aiDeclarationText: parsed.aiDeclarationText,
          citations: parsed.citations
            .filter((c) => sourceTitles.has(c.sourceId))
            .map((c) => ({ sourceId: c.sourceId, sourceTitle: sourceTitles.get(c.sourceId)!, quote: c.quote })),
          warnings: [],
        };
        return {
          draft,
          usage: {
            inputTokens: data.usage?.prompt_tokens ?? 0,
            outputTokens: data.usage?.completion_tokens ?? 0,
          },
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(`模型生成失败或结构校验未通过：${String(lastError)}`);
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      const data = await this.chat([{ role: "user", content: "回复 ok" }], false);
      const reply = data.choices[0]?.message?.content ?? "";
      return { ok: true, message: `连接成功（${this.options.model}）：${reply.slice(0, 40)}` };
    } catch (error) {
      return { ok: false, message: String(error instanceof Error ? error.message : error) };
    }
  }
}

function extractJson(content: string): string {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("模型输出中没有 JSON 对象");
  return content.slice(start, end + 1);
}
