import { getDb, decryptSecret } from "@aipeople/server-kit";

/**
 * Runner 按需取账号凭据：仅当该账号存在分配给此 Runner 的在途任务时放行，
 * 密文在服务端解密后经 TLS 返回，不落任务 JSON、日志或模型上下文。
 * （生产路径优先 Runner 本地凭据库，见方案 §4.4 / §6。）
 */
export async function fetchSecretForRunner(
  runnerId: string,
  accountId: string,
): Promise<{ ok: true; secret: Record<string, string> } | { ok: false; message: string }> {
  const { rows } = await getDb().query<{
    workspace_id: string;
    secret_encrypted: string | null;
    secret_ref: string | null;
  }>(
    `SELECT ac.workspace_id, ac.secret_encrypted, ac.secret_ref
     FROM account_connections ac
     WHERE ac.id = $1
       AND EXISTS (
         SELECT 1 FROM tasks t
         WHERE t.account_id = $1 AND t.runner_id = $2
           AND t.status IN ('WAITING_RUNNER', 'RUNNING')
       )
     LIMIT 1`,
    [accountId, runnerId],
  );
  const account = rows[0];
  if (!account) {
    return { ok: false, message: "账号不存在或没有分配给该设备的在途任务" };
  }
  if (!account.secret_encrypted) {
    return { ok: false, message: "该账号没有服务端凭据（可能要求本地凭据库）" };
  }
  const decrypted = decryptSecret(account.secret_encrypted);
  if (!decrypted) {
    return { ok: false, message: "凭据解密失败（VAULT_SECRET 可能已变更）" };
  }
  try {
    return { ok: true, secret: JSON.parse(decrypted) as Record<string, string> };
  } catch {
    return { ok: false, message: "凭据格式错误" };
  }
}
