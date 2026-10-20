import { getDb, randomId, randomToken, sha256Hex, withTransaction } from "@aipeople/server-kit";
import { recordEvent } from "./events.js";

export interface RunnerRow {
  id: string;
  workspace_id: string;
  name: string;
  device_token_hash: string;
  status: "paired" | "revoked";
  adapters: string[];
  last_heartbeat_at: Date | null;
  created_at: Date;
}

/** 创建一次性配对码（10 分钟有效）。 */
export async function createPairingCode(workspaceId: string): Promise<{ code: string; expiresAt: Date }> {
  const code = randomId("pair") + randomToken(6).replace(/[-_]/g, "").slice(0, 6);
  const expiresAt = new Date(Date.now() + 10 * 60_000);
  await getDb().query(
    `INSERT INTO pairing_codes (id, workspace_id, code, expires_at) VALUES ($3, $1, $2, $4)`,
    [workspaceId, code, randomId("pc"), expiresAt],
  );
  return { code, expiresAt };
}

/** Runner 用配对码换取设备凭据（一次性）。 */
export async function pairRunner(
  code: string,
  name: string,
  adapters: string[],
): Promise<{ ok: true; runnerId: string; deviceToken: string; workspaceId: string } | { ok: false; message: string }> {
  return await withTransaction(async (client) => {
    const pairing = (
      await client.query<{ id: string; workspace_id: string; expires_at: Date; used_at: Date | null }>(
        `SELECT id, workspace_id, expires_at, used_at FROM pairing_codes WHERE code = $1 FOR UPDATE`,
        [code],
      )
    ).rows[0];
    if (!pairing) return { ok: false, message: "配对码不存在" };
    if (pairing.used_at) return { ok: false, message: "配对码已被使用" };
    if (new Date(pairing.expires_at).getTime() < Date.now()) return { ok: false, message: "配对码已过期" };

    const runnerId = randomId("runner");
    const deviceToken = `rt_${randomToken(32)}`;
    await client.query(
      `INSERT INTO runners (id, workspace_id, name, device_token_hash, adapters)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [runnerId, pairing.workspace_id, name, sha256Hex(deviceToken), JSON.stringify(adapters)],
    );
    await client.query(`UPDATE pairing_codes SET used_at = now(), runner_id = $2 WHERE id = $1`, [pairing.id, runnerId]);
    await recordEvent(client, {
      workspaceId: pairing.workspace_id,
      type: "runner.online",
      payload: { runnerId, name, adapters },
      dedupeKey: `runner_paired:${runnerId}`,
    });
    return { ok: true, runnerId, deviceToken, workspaceId: pairing.workspace_id };
  });
}

/** 设备令牌认证：返回 Runner（无效或已撤销返回 null）。 */
export async function authenticateRunner(deviceToken: string): Promise<RunnerRow | null> {
  const { rows } = await getDb().query<RunnerRow>(
    `SELECT * FROM runners WHERE device_token_hash = $1 AND status = 'paired'`,
    [sha256Hex(deviceToken)],
  );
  return rows[0] ?? null;
}

/** 心跳：更新时间戳；从离线恢复时发上线事件（10 分钟去重）。 */
export async function updateHeartbeat(runnerId: string): Promise<void> {
  await withTransaction(async (client) => {
    const previous = (
      await client.query<{ last_heartbeat_at: Date | null; workspace_id: string; name: string }>(
        `SELECT last_heartbeat_at, workspace_id, name FROM runners WHERE id = $1`,
        [runnerId],
      )
    ).rows[0];
    if (!previous) return;
    const wasOffline =
      !previous.last_heartbeat_at || Date.now() - new Date(previous.last_heartbeat_at).getTime() > 90_000;
    await client.query(`UPDATE runners SET last_heartbeat_at = now() WHERE id = $1`, [runnerId]);
    if (wasOffline) {
      await recordEvent(client, {
        workspaceId: previous.workspace_id,
        type: "runner.online",
        payload: { runnerId, name: previous.name },
        dedupeKey: `runner_online:${runnerId}:${Math.floor(Date.now() / 600_000)}`,
      });
    }
  });
}

/** 标记心跳超时的 Runner 离线（10 分钟去重）。 */
export async function markStaleRunnersOffline(): Promise<void> {
  await withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string; workspace_id: string; name: string }>(
      `SELECT id, workspace_id, name FROM runners
       WHERE status = 'paired'
         AND (last_heartbeat_at IS NULL OR last_heartbeat_at < now() - interval '90 seconds')
         AND NOT EXISTS (
           SELECT 1 FROM events e
           WHERE e.type = 'runner.offline'
             AND e.dedupe_key = 'runner_offline:' || runners.id || ':' || to_char(now(), 'YYYYMMDDHH24MI5')
             AND e.created_at > now() - interval '5 minutes'
         )`,
    );
    for (const runner of rows) {
      await recordEvent(client, {
        workspaceId: runner.workspace_id,
        type: "runner.offline",
        payload: { runnerId: runner.id, name: runner.name },
        dedupeKey: `runner_offline:${runner.id}:${Math.floor(Date.now() / 600_000)}`,
      });
    }
  });
}

/** 撤销 Runner：阻止新任务领取；已提交动作照常收集结果（方案 §6）。 */
export async function revokeRunner(workspaceId: string, runnerId: string): Promise<boolean> {
  const result = await getDb().query(
    `UPDATE runners SET status = 'revoked' WHERE workspace_id = $1 AND id = $2 AND status = 'paired'`,
    [workspaceId, runnerId],
  );
  return (result.rowCount ?? 0) > 0;
}
