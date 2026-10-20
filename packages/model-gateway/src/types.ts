import type { Platform } from "@aipeople/contracts";

export interface GenerateDraftRequest {
  goal: string;
  platform: Platform;
  accountName?: string;
  brandTone?: string;
  sources: {
    id: string;
    title: string;
    excerpt: string;
    expiresAt?: string | null;
  }[];
}

export interface GeneratedDraft {
  title: string;
  body: string;
  topics: string[];
  declarations: { aiGenerated: boolean; commercial: boolean };
  aiDeclarationText: string;
  citations: { sourceId: string; sourceTitle: string; quote: string }[];
  /** 生成过程中的提示（如资料过期需复核），随版本保存并展示给审核人。 */
  warnings: string[];
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
}

export type ProviderAdapterId = "mock" | "openai_compatible";

export interface ProviderConfig {
  id: string;
  workspaceId: string;
  name: string;
  adapter: ProviderAdapterId;
  baseUrl?: string | null;
  apiKey?: string | null;
  model?: string | null;
  /** 单价：元 / 百万 tokens，用于费用估算。 */
  pricePerMillion: { input: number; output: number };
  enabled: boolean;
  isDefault: boolean;
}

export interface ModelProviderAdapter {
  readonly adapterId: ProviderAdapterId;
  generateDraft(req: GenerateDraftRequest): Promise<{ draft: GeneratedDraft; usage: ProviderUsage }>;
  testConnection(): Promise<{ ok: boolean; message: string }>;
}

export interface AdapterDescriptor {
  id: ProviderAdapterId;
  label: string;
  description: string;
  needsBaseUrl: boolean;
  needsApiKey: boolean;
}

export const PROVIDER_ADAPTERS: AdapterDescriptor[] = [
  {
    id: "mock",
    label: "内置 Mock",
    description: "不依赖外部模型，基于资料模板生成草稿，用于演示与测试",
    needsBaseUrl: false,
    needsApiKey: false,
  },
  {
    id: "openai_compatible",
    label: "OpenAI 兼容接口",
    description: "适配智谱 GLM、DeepSeek、通义、Kimi、OpenAI 等兼容 /chat/completions 的服务",
    needsBaseUrl: true,
    needsApiKey: true,
  },
];

export function estimateCostCny(usage: ProviderUsage, price: { input: number; output: number }): number {
  return (usage.inputTokens / 1_000_000) * price.input + (usage.outputTokens / 1_000_000) * price.output;
}
