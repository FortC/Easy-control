import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/** 用户口令哈希：scrypt（无原生依赖）。格式 scrypt$N$r$p$salt_b64$hash_b64。 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const N = 16384;
  const hash = scryptSync(password, salt, 32, { N, r: 8, p: 1 });
  return `scrypt$${N}$8$1$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const salt = Buffer.from(parts[4]!, "base64");
  const expected = Buffer.from(parts[5]!, "base64");
  const actual = scryptSync(password, salt, expected.length, { N, r: 8, p: 1 });
  return timingSafeEqual(actual, expected);
}

function vaultKey(): Buffer {
  const secret = process.env.VAULT_SECRET ?? process.env.JWT_SECRET ?? "dev-vault-secret";
  return createHash("sha256").update(secret, "utf8").digest();
}

/** 服务端敏感字段（模型 API Key 等）静态加密：AES-256-GCM。格式 v1$iv$tag$cipher（base64）。 */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", vaultKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1$${iv.toString("base64")}$${tag.toString("base64")}$${encrypted.toString("base64")}`;
}

export function decryptSecret(stored: string): string | null {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  try {
    const iv = Buffer.from(parts[1]!, "base64");
    const tag = Buffer.from(parts[2]!, "base64");
    const data = Buffer.from(parts[3]!, "base64");
    const decipher = createDecipheriv("aes-256-gcm", vaultKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`;
}
