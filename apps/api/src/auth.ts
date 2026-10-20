import type { FastifyReply, FastifyRequest } from "fastify";
import { SignJWT, jwtVerify } from "jose";
import { hashPassword, verifyPassword } from "@aipeople/server-kit";
import { config } from "./env.js";

export interface TokenClaims {
  sub: string;
  ws: string;
  role: "admin" | "editor" | "reviewer" | "viewer";
  name: string;
}

const secretKey = () => new TextEncoder().encode(config.jwtSecret);

export async function signUserToken(claims: TokenClaims): Promise<string> {
  return new SignJWT({ ws: claims.ws, role: claims.role, name: claims.name })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(secretKey());
}

export async function verifyUserToken(token: string): Promise<TokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey());
    if (typeof payload.sub !== "string" || typeof payload.ws !== "string") return null;
    return {
      sub: payload.sub,
      ws: payload.ws,
      role: (payload.role as TokenClaims["role"]) ?? "viewer",
      name: typeof payload.name === "string" ? payload.name : "",
    };
  } catch {
    return null;
  }
}

export { hashPassword, verifyPassword };

export interface AuthedRequest extends FastifyRequest {
  user: TokenClaims;
}

/** 需要登录的路由用它做前置校验。 */
export async function requireUser(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = request.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const claims = token ? await verifyUserToken(token) : null;
  if (!claims) {
    await reply.code(401).send({ error: "unauthorized", message: "请先登录" });
    return;
  }
  (request as AuthedRequest).user = claims;
}

/** 需要写权限（管理员/运营编辑）的路由。 */
export async function requireEditor(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireUser(request, reply);
  if (reply.statusCode === 401) return;
  const role = (request as AuthedRequest).user.role;
  if (role !== "admin" && role !== "editor") {
    await reply.code(403).send({ error: "forbidden", message: "需要管理员或运营编辑权限" });
  }
}

/** 仅管理员。 */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireUser(request, reply);
  if (reply.statusCode === 401) return;
  if ((request as AuthedRequest).user.role !== "admin") {
    await reply.code(403).send({ error: "forbidden", message: "需要管理员权限" });
  }
}
