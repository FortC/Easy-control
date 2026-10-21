import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getDb, randomId, decryptSecret, withTransaction } from "@aipeople/server-kit";
import {
  computeContentHash,
  isPlatform,
  PUBLISH_ACTION_BY_PLATFORM,
  PLATFORM_LABELS,
  type Platform,
} from "@aipeople/contracts";
import { retrieveRelevantSources, type SourceKind, type SourceRecord } from "@aipeople/knowledge";
import { MockProvider, OpenAICompatProvider, estimateCostCny, type ModelProviderAdapter } from "@aipeople/model-gateway";
import { requireUser, requireEditor, type AuthedRequest } from "../auth.js";

const PrepareSchema = z.object({
  goal: z.string().min(2),
  targets: z
    .array(z.object({ platform: z.string().refine(isPlatform), accountId: z.string().min(1) }))
    .min(1)
    .max(4),
  sourceIds: z.array(z.string()).optional(),
});

const UpdateContentSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  topics: z.array(z.string()).default([]),
  assetIds: z.array(z.string()).default([]),
  declarations: z
    .object({ aiGenerated: z.boolean(), commercial: z.boolean() })
    .default({ aiGenerated: true, commercial: false }),
});

async function resolveDefaultProvider(workspaceId: string): Promise<{ provider: ModelProviderAdapter; row: { id: string; name: string; model: string | null; price: { input: number; output: number } } }> {
  const { rows } = await getDb().query<{
    id: string;
    name: string;
    adapter: "mock" | "openai_compatible";
    base_url: string | null;
    api_key_encrypted: string | null;
    model: string | null;
    price_input: number;
    price_output: number;
  }>(
    `SELECT id, name, adapter, base_url, api_key_encrypted, model, price_input, price_output
     FROM model_providers WHERE workspace_id = $1 AND enabled = true
     ORDER BY is_default DESC, created_at ASC LIMIT 1`,
    [workspaceId],
  );
  const row = rows[0];
  if (!row) {
    return {
      provider: new MockProvider(),
      row: { id: "builtin-mock", name: "内置 Mock（未配置）", model: "mock", price: { input: 0, output: 0 } },
    };
  }
  if (row.adapter === "mock") {
    return { provider: new MockProvider(), row: { id: row.id, name: row.name, model: "mock", price: { input: Number(row.price_input), output: Number(row.price_output) } } };
  }
  const apiKey = row.api_key_encrypted ? decryptSecret(row.api_key_encrypted) : null;
  if (!row.base_url || !apiKey) {
    return {
      provider: new MockProvider(),
      row: { id: row.id, name: `${row.name}（配置不全，回退 Mock）`, model: "mock", price: { input: 0, output: 0 } },
    };
  }
  return {
    provider: new OpenAICompatProvider({ baseUrl: row.base_url, apiKey, model: row.model ?? "gpt-4o-mini" }),
    row: { id: row.id, name: row.name, model: row.model, price: { input: Number(row.price_input), output: Number(row.price_output) } },
  };
}

export async function contentRoutes(app: FastifyInstance): Promise<void> {
  /** 内容准备：按平台生成草稿（模型只产内容，不碰工具权限）。 */
  app.post("/contents/prepare", { preHandler: requireEditor }, async (request, reply) => {
    const body = PrepareSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request", message: body.error.issues[0]?.message });
    const ws = (request as AuthedRequest).user.ws;
    const user = (request as AuthedRequest).user;

    const db = getDb();
    const allSources = (
      await db.query<{ id: string; kind: string; title: string; content: string; copyright: string | null; expires_at: Date | null }>(
        `SELECT id, kind, title, content, copyright, expires_at FROM sources WHERE workspace_id = $1 ORDER BY created_at DESC`,
        [ws],
      )
    ).rows;
    const sourceRecords: SourceRecord[] = allSources.map((s) => ({
      id: s.id,
      workspaceId: ws,
      kind: s.kind as SourceKind,
      title: s.title,
      content: s.content,
      copyright: s.copyright,
      licenseScope: null,
      owner: null,
      expiresAt: s.expires_at?.toISOString() ?? null,
      createdAt: new Date().toISOString(),
    }));
    const chosen = body.data.sourceIds
      ? sourceRecords.filter((s) => body.data.sourceIds!.includes(s.id))
      : retrieveRelevantSources(sourceRecords, body.data.goal).map((entry) => entry.source);

    const { provider, row: providerRow } = await resolveDefaultProvider(ws);
    const created: unknown[] = [];
    for (const target of body.data.targets) {
      const account = (
        await db.query<{ id: string; platform: Platform; display_name: string | null; channel: string }>(
          `SELECT id, platform, display_name, channel FROM account_connections WHERE workspace_id = $1 AND id = $2`,
          [ws, target.accountId],
        )
      ).rows[0];
      if (!account || account.platform !== target.platform) {
        return reply.code(400).send({ error: "bad_request", message: `目标账号不属于平台 ${PLATFORM_LABELS[target.platform as Platform]}` });
      }
      const { draft, usage } = await provider.generateDraft({
        goal: body.data.goal,
        platform: target.platform as Platform,
        accountName: account.display_name ?? undefined,
        sources: chosen.map((s) => ({ id: s.id, title: s.title, excerpt: s.content.slice(0, 160), expiresAt: s.expiresAt ?? null })),
      });
      const versionId = randomId("cv");
      const hash = computeContentHash({
        title: draft.title,
        body: draft.body,
        topics: draft.topics,
        assetIds: [],
        declarations: draft.declarations,
      });
      await db.query(
        `INSERT INTO content_versions (id, workspace_id, platform, title, body, topics, asset_ids, declarations,
           citations, warnings, model_info, status, hash, created_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, '[]'::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, 'draft', $11, $12)`,
        [
          versionId,
          ws,
          target.platform,
          draft.title,
          draft.body,
          JSON.stringify(draft.topics),
          JSON.stringify(draft.declarations),
          JSON.stringify(draft.citations),
          JSON.stringify(draft.warnings),
          JSON.stringify({ provider: providerRow.name, model: providerRow.model ?? "mock" }),
          hash,
          user.sub,
        ],
      );
      const cost = estimateCostCny(usage, providerRow.price);
      await db.query(
        `INSERT INTO cost_ledger (id, workspace_id, kind, amount_cny, detail) VALUES ($4, $1, 'model', $2, $3::jsonb)`,
        [ws, cost, JSON.stringify({ provider: providerRow.name, usage, purpose: "prepare_content" }), randomId("cost")],
      );
      created.push({
        id: versionId,
        platform: target.platform,
        accountId: target.accountId,
        title: draft.title,
        warnings: draft.warnings,
      });
    }
    return reply.code(201).send({ versions: created });
  });

  app.get("/contents", { preHandler: requireUser }, async (request) => {
    const ws = (request as AuthedRequest).user.ws;
    const query = z.object({ status: z.string().optional(), platform: z.string().optional() }).parse(request.query ?? {});
    const conditions = [`workspace_id = $1`];
    const params: unknown[] = [ws];
    if (query.status) {
      params.push(query.status);
      conditions.push(`status = $${params.length}`);
    }
    if (query.platform) {
      params.push(query.platform);
      conditions.push(`platform = $${params.length}`);
    }
    const { rows } = await getDb().query(
      `SELECT cv.*, 
         (SELECT json_agg(json_build_object('id', a.id, 'name', a.display_name, 'platform', a.platform))
          FROM approvals ap JOIN account_connections a ON a.id = ap.account_id
          WHERE ap.content_version_id = cv.id AND ap.status = 'active') AS approvals
       FROM content_versions cv WHERE ${conditions.join(" AND ")} ORDER BY cv.created_at DESC LIMIT 100`,
      params,
    );
    return { contents: rows };
  });

  app.get("/contents/:id", { preHandler: requireUser }, async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const ws = (request as AuthedRequest).user.ws;
    const content = (
      await getDb().query(`SELECT * FROM content_versions WHERE workspace_id = $1 AND id = $2`, [ws, id])
    ).rows[0];
    if (!content) return reply.code(404).send({ error: "not_found", message: "内容不存在" });
    const approvals = await getDb().query(
      `SELECT ap.*, u.display_name AS approver FROM approvals ap LEFT JOIN users u ON u.id = ap.approved_by
       WHERE ap.workspace_id = $1 AND ap.content_version_id = $2 ORDER BY ap.approved_at DESC`,
      [ws, id],
    );
    const tasks = await getDb().query(
      `SELECT id, status, occurrence_at, action FROM tasks WHERE workspace_id = $1 AND content_version_id = $2 ORDER BY occurrence_at DESC LIMIT 20`,
      [ws, id],
    );
    return { content, approvals: approvals.rows, tasks: tasks.rows };
  });

  /** 编辑内容：重新计算哈希；已审核内容回到草稿，旧审批因哈希不符自然失效。 */
  app.put("/contents/:id", { preHandler: requireEditor }, async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = UpdateContentSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request", message: body.error.issues[0]?.message });
    const ws = (request as AuthedRequest).user.ws;
    const hash = computeContentHash({
      title: body.data.title,
      body: body.data.body,
      topics: body.data.topics,
      assetIds: body.data.assetIds,
      declarations: body.data.declarations,
    });
    const result = await getDb().query(
      `UPDATE content_versions SET title = $3, body = $4, topics = $5::jsonb, asset_ids = $6::jsonb,
         declarations = $7::jsonb, hash = $8, status = 'draft', updated_at = now()
       WHERE workspace_id = $1 AND id = $2 AND status NOT IN ('superseded')
       RETURNING id`,
      [ws, id, body.data.title, body.data.body, JSON.stringify(body.data.topics), JSON.stringify(body.data.assetIds), JSON.stringify(body.data.declarations), hash],
    );
    if (!result.rowCount) return reply.code(404).send({ error: "not_found", message: "内容不存在" });
    await getDb().query(
      `UPDATE approvals SET status = 'invalidated' WHERE workspace_id = $1 AND content_version_id = $2 AND status = 'active'`,
      [ws, id],
    );
    return { ok: true, hash };
  });

  app.post("/contents/:id/ready-for-review", { preHandler: requireEditor }, async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const ws = (request as AuthedRequest).user.ws;
    const result = await getDb().query(
      `UPDATE content_versions SET status = 'ready_for_review', updated_at = now()
       WHERE workspace_id = $1 AND id = $2 AND status IN ('draft', 'ready_for_review') RETURNING id`,
      [ws, id],
    );
    if (!result.rowCount) return reply.code(400).send({ error: "bad_request", message: "内容状态不允许送审" });
    return { ok: true };
  });

  /** 审批：绑定内容哈希+账号+动作+有效期（方案 §5.2 审批与状态机）。 */
  app.post("/content-versions/:id/approve", { preHandler: requireUser }, async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({
        accountId: z.string().min(1),
        action: z.string().min(1),
        validMinutes: z.number().int().min(1).max(60 * 24 * 30).default(24 * 60),
      })
      .safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "bad_request", message: body.error.issues[0]?.message });
    const ws = (request as AuthedRequest).user.ws;
    const user = (request as AuthedRequest).user;
    if (user.role !== "admin" && user.role !== "reviewer" && user.role !== "editor") {
      return reply.code(403).send({ error: "forbidden", message: "需要审核权限" });
    }

    const approvalId = await withTransaction(async (client) => {
      const content = (
        await client.query<{ platform: Platform; hash: string; status: string; asset_ids: string[] }>(
          `SELECT platform, hash, status, asset_ids FROM content_versions WHERE workspace_id = $1 AND id = $2`,
          [ws, id],
        )
      ).rows[0];
      if (!content) throw httpError(404, "内容不存在");
      if (content.status !== "ready_for_review" && content.status !== "approved") {
        throw httpError(400, "内容未送审");
      }
      const account = (
        await client.query<{ id: string; platform: Platform }>(
          `SELECT id, platform FROM account_connections WHERE workspace_id = $1 AND id = $2`,
          [ws, body.data.accountId],
        )
      ).rows[0];
      if (!account) throw httpError(400, "账号不存在");
      if (account.platform !== content.platform) throw httpError(400, "审批账号与内容平台不一致");
      if (body.data.action !== PUBLISH_ACTION_BY_PLATFORM[content.platform]) {
        throw httpError(400, "动作与平台不匹配");
      }
      const assets = (
        await client.query<{ sha256: string }>(
          `SELECT sha256 FROM assets WHERE workspace_id = $1 AND id = ANY($2::text[])`,
          [ws, content.asset_ids ?? []],
        )
      ).rows;
      const newApprovalId = randomId("apr");
      await client.query(
        `INSERT INTO approvals (id, workspace_id, content_version_id, platform, account_id, action, content_hash,
           asset_hashes, status, approved_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'active', $9, now() + ($10 || ' minutes')::interval)`,
        [
          newApprovalId,
          ws,
          id,
          content.platform,
          body.data.accountId,
          body.data.action,
          content.hash,
          JSON.stringify(assets.map((a) => a.sha256)),
          user.sub,
          String(body.data.validMinutes),
        ],
      );
      await client.query(`UPDATE content_versions SET status = 'approved', updated_at = now() WHERE id = $1`, [id]);
      return newApprovalId;
    });
    return { ok: true, approvalId };
  });
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}
