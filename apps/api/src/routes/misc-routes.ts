import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { z } from "zod";
import { getDb, randomId, encryptSecret, decryptSecret } from "@aipeople/server-kit";
import { MockProvider, OpenAICompatProvider, PROVIDER_ADAPTERS } from "@aipeople/model-gateway";
import { manuallyConfirmPublication } from "@aipeople/orchestration";
import { requireUser, requireEditor, requireAdmin, type AuthedRequest } from "../auth.js";
import { config } from "../env.js";

export async function miscRoutes(app: FastifyInstance): Promise<void> {
  const wsOf = (request: AuthedRequest) => request.user.ws;

  // ---------- 资料与素材 ----------

  app.get("/sources", { preHandler: requireUser }, async (request) => {
    const { rows } = await getDb().query(
      `SELECT id, kind, title, content, copyright, license_scope, owner, expires_at, created_at
       FROM sources WHERE workspace_id = $1 ORDER BY created_at DESC`,
      [wsOf(request as AuthedRequest)],
    );
    return { sources: rows };
  });

  app.post("/sources", { preHandler: requireEditor }, async (request, reply) => {
    const body = z
      .object({
        kind: z.enum(["brand", "product", "case", "policy"]),
        title: z.string().min(1),
        content: z.string().min(1),
        copyright: z.string().optional(),
        licenseScope: z.string().optional(),
        owner: z.string().optional(),
        expiresAt: z.string().optional(),
      })
      .safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request", message: body.error.issues[0]?.message });
    const id = randomId("src");
    await getDb().query(
      `INSERT INTO sources (id, workspace_id, kind, title, content, copyright, license_scope, owner, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        wsOf(request as AuthedRequest),
        body.data.kind,
        body.data.title,
        body.data.content,
        body.data.copyright ?? null,
        body.data.licenseScope ?? null,
        body.data.owner ?? null,
        body.data.expiresAt ? new Date(body.data.expiresAt) : null,
        (request as AuthedRequest).user.sub,
      ],
    );
    return reply.code(201).send({ id });
  });

  app.delete("/sources/:id", { preHandler: requireEditor }, async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const result = await getDb().query(`DELETE FROM sources WHERE workspace_id = $1 AND id = $2`, [
      wsOf(request as AuthedRequest),
      id,
    ]);
    if (!result.rowCount) return reply.code(404).send({ error: "not_found", message: "资料不存在" });
    return { ok: true };
  });

  /** 素材上传（multipart）：保存到 DATA_DIR，登记 sha256 与 AI 参与标记。 */
  app.post("/assets", { preHandler: requireEditor }, async (request, reply) => {
    const ws = wsOf(request as AuthedRequest);
    const file = await request.file();
    if (!file) return reply.code(400).send({ error: "bad_request", message: "缺少文件" });
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "video/quicktime"];
    if (!allowed.includes(file.mimetype)) {
      return reply.code(400).send({ error: "bad_request", message: `不支持的文件类型：${file.mimetype}` });
    }
    const buffer = await file.toBuffer();
    if (buffer.length > 50 * 1024 * 1024) {
      return reply.code(400).send({ error: "bad_request", message: "文件超过 50MB 限制" });
    }
    const id = randomId("asset");
    const ext = extname(file.filename) || (file.mimetype === "video/mp4" ? ".mp4" : ".jpg");
    const dir = join(config.dataDir, "assets", ws);
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, `${id}${ext}`);
    await writeFile(filePath, buffer);
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    await getDb().query(
      `INSERT INTO assets (id, workspace_id, sha256, file_path, mime_type, size_bytes, ai_involved)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, ws, sha256, filePath, file.mimetype, buffer.length, false],
    );
    return reply.code(201).send({ id, sha256, filename: file.filename, sizeBytes: buffer.length, filePath });
  });

  app.get("/assets", { preHandler: requireUser }, async (request) => {
    const { rows } = await getDb().query(
      `SELECT id, sha256, mime_type, size_bytes, ai_involved, created_at FROM assets
       WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [wsOf(request as AuthedRequest)],
    );
    return { assets: rows };
  });

  // ---------- 助手与模型 ----------

  app.get("/model-providers", { preHandler: requireUser }, async (request) => {
    const { rows } = await getDb().query(
      `SELECT id, name, adapter, base_url, model, price_input, price_output, enabled, is_default, created_at,
              (api_key_encrypted IS NOT NULL) AS has_api_key
       FROM model_providers WHERE workspace_id = $1 ORDER BY is_default DESC, created_at`,
      [wsOf(request as AuthedRequest)],
    );
    return { providers: rows, adapters: PROVIDER_ADAPTERS };
  });

  app.post("/model-providers", { preHandler: requireAdmin }, async (request, reply) => {
    const body = z
      .object({
        name: z.string().min(1),
        adapter: z.enum(["mock", "openai_compatible"]),
        baseUrl: z.string().url().optional(),
        apiKey: z.string().optional(),
        model: z.string().optional(),
        priceInput: z.number().min(0).default(0),
        priceOutput: z.number().min(0).default(0),
        isDefault: z.boolean().default(false),
      })
      .safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request", message: body.error.issues[0]?.message });
    if (body.data.adapter === "openai_compatible" && (!body.data.baseUrl || !body.data.apiKey)) {
      return reply.code(400).send({ error: "bad_request", message: "OpenAI 兼容供应商需要 base URL 与 API Key" });
    }
    const ws = wsOf(request as AuthedRequest);
    const id = randomId("mp");
    const client = await getDb().connect();
    try {
      await client.query("BEGIN");
      if (body.data.isDefault) {
        await client.query(`UPDATE model_providers SET is_default = false WHERE workspace_id = $1`, [ws]);
      }
      await client.query(
        `INSERT INTO model_providers (id, workspace_id, name, adapter, base_url, api_key_encrypted, model,
           price_input, price_output, enabled, is_default)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10)`,
        [
          id,
          ws,
          body.data.name,
          body.data.adapter,
          body.data.baseUrl ?? null,
          body.data.apiKey ? encryptSecret(body.data.apiKey) : null,
          body.data.model ?? null,
          body.data.priceInput,
          body.data.priceOutput,
          body.data.isDefault,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return reply.code(201).send({ id });
  });

  app.post("/model-providers/:id/test", { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const ws = wsOf(request as AuthedRequest);
    const { rows } = await getDb().query<{
      adapter: "mock" | "openai_compatible";
      base_url: string | null;
      api_key_encrypted: string | null;
      model: string | null;
    }>(`SELECT adapter, base_url, api_key_encrypted, model FROM model_providers WHERE workspace_id = $1 AND id = $2`, [ws, id]);
    const provider = rows[0];
    if (!provider) return reply.code(404).send({ error: "not_found", message: "供应商不存在" });
    if (provider.adapter === "mock") {
      return await new MockProvider().testConnection();
    }
    const apiKey = provider.api_key_encrypted ? decryptSecret(provider.api_key_encrypted) : null;
    if (!provider.base_url || !apiKey) {
      return { ok: false, message: "缺少 base URL 或 API Key" };
    }
    return await new OpenAICompatProvider({
      baseUrl: provider.base_url,
      apiKey,
      model: provider.model ?? "gpt-4o-mini",
    }).testConnection();
  });

  app.patch("/model-providers/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({ enabled: z.boolean().optional(), isDefault: z.boolean().optional(), model: z.string().optional() })
      .parse(request.body ?? {});
    const ws = wsOf(request as AuthedRequest);
    if (body.isDefault) {
      await getDb().query(`UPDATE model_providers SET is_default = false WHERE workspace_id = $1`, [ws]);
    }
    const result = await getDb().query(
      `UPDATE model_providers SET
         enabled = COALESCE($3, enabled), is_default = COALESCE($4, is_default), model = COALESCE($5, model)
       WHERE workspace_id = $1 AND id = $2`,
      [ws, id, body.enabled ?? null, body.isDefault ?? null, body.model ?? null],
    );
    if (!result.rowCount) return reply.code(404).send({ error: "not_found", message: "供应商不存在" });
    return { ok: true };
  });

  app.delete("/model-providers/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const result = await getDb().query(
      `DELETE FROM model_providers WHERE workspace_id = $1 AND id = $2`,
      [wsOf(request as AuthedRequest), id],
    );
    if (!result.rowCount) return reply.code(404).send({ error: "not_found", message: "供应商不存在" });
    return { ok: true };
  });

  // ---------- 结果与数据 ----------

  app.get("/publications", { preHandler: requireUser }, async (request) => {
    const { rows } = await getDb().query(
      `SELECT p.*, t.status AS task_status, t.action, ac.display_name AS account_name, cv.title AS content_title,
         (SELECT metrics FROM metric_snapshots m WHERE m.publication_id = p.id ORDER BY m.captured_at DESC LIMIT 1) AS latest_metrics
       FROM publications p
       JOIN tasks t ON t.id = p.task_id
       JOIN account_connections ac ON ac.id = p.account_id
       JOIN content_versions cv ON cv.id = t.content_version_id
       WHERE p.workspace_id = $1 ORDER BY p.updated_at DESC LIMIT 100`,
      [wsOf(request as AuthedRequest)],
    );
    return { publications: rows };
  });

  /** 人工登记发布链接（不与接口确认混淆，方案 §9.2）。 */
  app.post("/publications/:taskId/manual-confirm", { preHandler: requireEditor }, async (request, reply) => {
    const { taskId } = z.object({ taskId: z.string() }).parse(request.params);
    const body = z.object({ url: z.string().url() }).safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "bad_request", message: "链接格式不正确" });
    const ok = await manuallyConfirmPublication(wsOf(request as AuthedRequest), taskId, body.data.url);
    if (!ok) return reply.code(404).send({ error: "not_found", message: "发布记录不存在" });
    return { ok: true };
  });

  // ---------- 异常处理 ----------

  app.get("/incidents", { preHandler: requireUser }, async (request) => {
    const query = z.object({ status: z.enum(["open", "resolved", "all"]).default("open") }).parse(request.query ?? {});
    const ws = wsOf(request as AuthedRequest);
    const filter = query.status === "all" ? "" : `AND i.status = $2`;
    const params: unknown[] = query.status === "all" ? [ws] : [ws, query.status];
    const { rows } = await getDb().query(
      `SELECT i.*, ac.display_name AS account_name, cv.title AS content_title
       FROM incidents i
       LEFT JOIN account_connections ac ON ac.id = i.account_id
       LEFT JOIN tasks t ON t.id = i.task_id
       LEFT JOIN content_versions cv ON cv.id = t.content_version_id
       WHERE i.workspace_id = $1 ${filter}
       ORDER BY i.created_at DESC LIMIT 100`,
      params,
    );
    return { incidents: rows };
  });

  app.post("/incidents/:id/resolve", { preHandler: requireEditor }, async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ note: z.string().default("") }).parse(request.body ?? {});
    const ws = wsOf(request as AuthedRequest);
    const result = await getDb().query(
      `UPDATE incidents SET status = 'resolved', resolution_note = $3, resolved_at = now()
       WHERE workspace_id = $1 AND id = $2 AND status = 'open'`,
      [ws, id, body.note],
    );
    if (!result.rowCount) return reply.code(404).send({ error: "not_found", message: "异常不存在或已处理" });
    return { ok: true };
  });

  // ---------- 工作空间设置与总览 ----------

  app.get("/settings", { preHandler: requireUser }, async (request) => {
    const { rows } = await getDb().query(
      `SELECT id, name, timezone, aigc_policy, daily_budget_cny, brand_tone FROM workspaces WHERE id = $1`,
      [wsOf(request as AuthedRequest)],
    );
    return { settings: rows[0] ?? null };
  });

  app.patch("/settings", { preHandler: requireAdmin }, async (request, reply) => {
    const body = z
      .object({
        name: z.string().min(1).optional(),
        timezone: z.string().optional(),
        aigcPolicy: z.enum(["strict", "in_text", "off"]).optional(),
        dailyBudgetCny: z.number().min(0).nullable().optional(),
        brandTone: z.string().optional(),
      })
      .parse(request.body ?? {});
    const ws = wsOf(request as AuthedRequest);
    await getDb().query(
      `UPDATE workspaces SET
         name = COALESCE($3, name), timezone = COALESCE($4, timezone),
         aigc_policy = COALESCE($5, aigc_policy), daily_budget_cny = COALESCE($6, daily_budget_cny),
         brand_tone = COALESCE($7, brand_tone)
       WHERE id = $1`,
      [
        ws,
        undefined,
        body.name ?? null,
        body.timezone ?? null,
        body.aigcPolicy ?? null,
        body.dailyBudgetCny === undefined ? null : body.dailyBudgetCny,
        body.brandTone ?? null,
      ],
    );
    return { ok: true };
  });

  app.get("/overview", { preHandler: requireUser }, async (request) => {
    const ws = wsOf(request as AuthedRequest);
    const db = getDb();
    const [today, pendingReview, needsHuman, runners, openIncidents, recent] = await Promise.all([
      db.query(
        `SELECT COUNT(*)::int AS count FROM tasks
         WHERE workspace_id = $1 AND (occurrence_at AT TIME ZONE 'Asia/Shanghai')::date = (now() AT TIME ZONE 'Asia/Shanghai')::date`,
        [ws],
      ),
      db.query(`SELECT COUNT(*)::int AS count FROM content_versions WHERE workspace_id = $1 AND status = 'ready_for_review'`, [ws]),
      db.query(`SELECT COUNT(*)::int AS count FROM tasks WHERE workspace_id = $1 AND status = 'NEEDS_HUMAN'`, [ws]),
      db.query(
        `SELECT id, name, (last_heartbeat_at > now() - interval '90 seconds') AS online, last_heartbeat_at
         FROM runners WHERE workspace_id = $1 AND status = 'paired'`,
        [ws],
      ),
      db.query(`SELECT COUNT(*)::int AS count FROM incidents WHERE workspace_id = $1 AND status = 'open'`, [ws]),
      db.query(
        `SELECT p.id, p.platform, p.publication_status, p.url, p.updated_at, cv.title AS content_title
         FROM publications p JOIN content_versions cv ON cv.id = (SELECT content_version_id FROM tasks WHERE id = p.task_id)
         WHERE p.workspace_id = $1 ORDER BY p.updated_at DESC LIMIT 5`,
        [ws],
      ),
    ]);
    return {
      todayTasks: today.rows[0].count,
      pendingReview: pendingReview.rows[0].count,
      needsHuman: needsHuman.rows[0].count,
      openIncidents: openIncidents.rows[0].count,
      runners: runners.rows,
      recentPublications: recent.rows,
    };
  });
}
