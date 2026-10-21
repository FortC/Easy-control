import { loadEnvFile, envNumber } from "@aipeople/server-kit";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// esbuild CJS 打包中 import.meta.url 不可用：降级到 process.cwd()
let rootDir = process.cwd();
try {
  rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
} catch {
  /* 打包环境使用 cwd */
}
loadEnvFile(rootDir);

export const config = {
  port: envNumber("API_PORT", 8787),
  jwtSecret: process.env.JWT_SECRET ?? "dev-secret-change-me",
  dataDir: resolve(rootDir, process.env.DATA_DIR ?? ".local"),
};
