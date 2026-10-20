import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { authRoutes } from "./routes/auth-routes.js";
import { accountRoutes } from "./routes/account-routes.js";
import { runnerRoutes } from "./routes/runner-routes.js";
import { contentRoutes } from "./routes/content-routes.js";
import { scheduleRoutes } from "./routes/schedule-routes.js";
import { taskRoutes } from "./routes/task-routes.js";
import { miscRoutes } from "./routes/misc-routes.js";

export async function buildServer() {
  const app = Fastify({
    logger: false,
    bodyLimit: 10 * 1024 * 1024,
  });

  await app.register(cors, { origin: true });
  await app.register(multipart, {
    limits: { fileSize: 50 * 1024 * 1024, files: 10 },
  });

  app.get("/health", async () => ({ ok: true, service: "aipeople-api", time: new Date().toISOString() }));

  await app.register(authRoutes);
  await app.register(accountRoutes);
  await app.register(runnerRoutes);
  await app.register(contentRoutes);
  await app.register(scheduleRoutes);
  await app.register(taskRoutes);
  await app.register(miscRoutes);

  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    if (status >= 500) {
      console.error("[api] 未处理错误：", error.message);
    }
    reply.code(status).send({
      error: status === 500 ? "internal" : "bad_request",
      message: status === 500 ? "服务器内部错误" : error.message,
    });
  });

  return app;
}
