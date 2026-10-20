import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** 加载仓库根目录 .env（存在时），不覆盖已设置的环境变量。 */
export function loadEnvFile(root = process.cwd()): void {
  const envPath = resolve(root, ".env");
  if (!existsSync(envPath)) return;
  try {
    process.loadEnvFile(envPath);
  } catch {
    // 文件不存在或格式问题：忽略，使用进程环境变量
  }
}

export function requireEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`缺少环境变量 ${name}（参考 .env.example）`);
  }
  return value;
}

export function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}
