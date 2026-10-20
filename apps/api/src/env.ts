import { loadEnvFile, envNumber } from "@aipeople/server-kit";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
loadEnvFile(rootDir);

export const config = {
  port: envNumber("API_PORT", 8787),
  jwtSecret: process.env.JWT_SECRET ?? "dev-secret-change-me",
  dataDir: resolve(rootDir, process.env.DATA_DIR ?? ".local"),
};
