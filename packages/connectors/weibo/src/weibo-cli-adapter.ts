import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import type {
  AdapterCapability,
  AdapterContext,
  AdapterReconcileResult,
  AdapterSubmitResult,
  AdapterVerifyResult,
  PlatformAdapter,
} from "@aipeople/contracts";

/**
 * 微博官方 weibo-cli 包装器（方案 §2：官方 CLI，由本地 Runner 执行）。
 *
 * 状态：UNVERIFIED —— 命令语法按官方手册页面结构实现的最小集合，须在真实环境
 * 用 `weibo commands list --available` 探测后核对（方案 §3.3 第 3 步）。
 *
 * 安全约束：
 * - 只允许白名单命令，参数由结构化 payload 生成，shell:false，不做字符串拼接；
 * - AI 生成内容必须带 --ai 属性声明（方案 §2 已知依赖）；
 * - 每个命令带超时；不提供任意命令入口。
 */

export type WeiboCommandName = "doctor" | "commands_list" | "publish";

export interface WeiboRunOptions {
  binary?: string;
  cwd?: string;
  timeoutMs?: number;
}

interface CliInvocation {
  args: string[];
}

function buildInvocation(name: WeiboCommandName, payload: Record<string, unknown>): CliInvocation {
  switch (name) {
    case "doctor":
      return { args: ["doctor", "--json"] };
    case "commands_list":
      return { args: ["commands", "list", "--available", "--json"] };
    case "publish": {
      const text = requireString(payload, "text");
      const args = ["post", "--json"];
      if (payload.ai === true) args.push("--ai"); // AI 生成声明，平台加标识
      args.push("--text", text);
      const images = requireStringArray(payload, "images");
      for (const image of images) args.push("--image", image);
      return { args };
    }
    default: {
      const never: never = name;
      throw new Error(`未知微博命令：${String(never)}`);
    }
  }
}

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`微博命令参数 ${key} 必须是非空字符串`);
  return value;
}

function requireStringArray(payload: Record<string, unknown>, key: string): string[] {
  const value = payload[key];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    return [];
  }
  return value as string[];
}

export class WeiboCliAdapter implements PlatformAdapter {
  readonly channel = "weibo_cli" as const;

  constructor(private options: WeiboRunOptions = {}) {}

  private get binary(): string {
    return this.options.binary ?? "weibo";
  }

  capabilities(): AdapterCapability[] {
    return [
      { action: "publish_post", available: true, notes: "UNVERIFIED：需本机安装官方 weibo-cli 并完成 OAuth" },
      { action: "reply_comment", available: false, notes: "互动命令待命令目录实测后单独评估" },
      { action: "pull_metrics", available: false, notes: "授权数据读取待实测" },
    ];
  }

  /** 执行白名单命令：参数数组 + shell:false + 超时；返回最后一个 JSON 对象与完整输出。 */
  async runCommand(
    name: WeiboCommandName,
    payload: Record<string, unknown> = {},
  ): Promise<{ ok: true; json: unknown; stdout: string } | { ok: false; code: string; message: string; stderr: string }> {
    const { args } = buildInvocation(name, payload);
    return await new Promise((resolve) => {
      const child = spawn(this.binary, args, {
        shell: false,
        cwd: this.options.cwd,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill(), this.options.timeoutMs ?? 120_000);
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      child.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        resolve({
          ok: false,
          code: error.code === "ENOENT" ? "not_configured" : "internal",
          message: `无法启动 weibo CLI（${this.binary}）：${error.message}`,
          stderr,
        });
      });
      child.on("close", (exitCode) => {
        clearTimeout(timer);
        if (exitCode !== 0) {
          resolve({
            ok: false,
            code: "platform_error",
            message: `weibo CLI 退出码 ${exitCode}：${lastNonEmptyLine(stderr) || lastNonEmptyLine(stdout)}`,
            stderr,
          });
          return;
        }
        resolve({ ok: true, json: extractLastJson(stdout), stdout });
      });
    });
  }

  async verifyAccount(_ctx: AdapterContext): Promise<AdapterVerifyResult> {
    const result = await this.runCommand("doctor");
    if (!result.ok) {
      return { ok: false, errorCode: result.code as never, errorMessage: result.message };
    }
    const info = (result.json ?? {}) as Record<string, unknown>;
    const uid = typeof info.uid === "string" ? info.uid : undefined;
    return { ok: true, uid, displayName: typeof info.name === "string" ? info.name : undefined };
  }

  async submit(ctx: AdapterContext): Promise<AdapterSubmitResult> {
    const { content } = ctx.envelope;
    for (const imagePath of content.assetPaths) {
      try {
        await access(imagePath);
      } catch {
        return { outcome: "failed", errorCode: "internal", errorMessage: `素材文件不存在：${imagePath}` };
      }
    }
    ctx.log("weibo: 调用官方 CLI 发布", { ai: content.declarations.aiGenerated, images: content.assetPaths.length });
    const text = content.title ? `${content.title}\n${content.body}` : content.body;
    const result = await this.runCommand("publish", {
      text,
      images: content.assetPaths,
      ai: content.declarations.aiGenerated,
    });
    if (!result.ok) {
      return { outcome: "failed", errorCode: result.code as never, errorMessage: result.message };
    }
    const data = (result.json ?? {}) as Record<string, unknown>;
    const externalId = typeof data.id === "string" || typeof data.id === "number" ? String(data.id) : undefined;
    if (!externalId) {
      // 退出码 0 不等于发布成功（方案 §13 验收）：没有回执 ID 时保守标记
      return { outcome: "unknown", errorMessage: "CLI 未返回博文 ID，无法确认发布结果", raw: result.json };
    }
    const url = typeof data.url === "string" ? data.url : `https://weibo.com/detail/${externalId}`;
    return { outcome: "submitted", externalId, url, raw: result.json };
  }

  async reconcile(_ctx: AdapterContext, _externalId: string): Promise<AdapterReconcileResult> {
    // 待命令目录实测后接入状态回读；当前保持未确认
    return { publicationStatus: "unverified" };
  }
}

function extractLastJson(stdout: string): unknown {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim().startsWith("{"));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]!);
    } catch {
      continue;
    }
  }
  return null;
}

function lastNonEmptyLine(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "";
}
