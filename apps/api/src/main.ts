import { buildServer } from "./server.js";
import { config } from "./env.js";

async function main() {
  const app = await buildServer();
  await app.listen({ port: config.port, host: "0.0.0.0" });
  console.log(`[api] 监听 http://localhost:${config.port}`);
}

main().catch((error) => {
  console.error("[api] 启动失败：", error);
  process.exit(1);
});
