import { HttpError } from "../src/lib/http";
import type { User } from "../src/lib/types";
import type { Env } from "./types";
const encode = new TextEncoder();
export const SESSION_AGE_SECONDS = 30 * 24 * 60 * 60;
const refreshedCookies = new WeakMap<Request, string>();
export const renewedSessionCookie = (request: Request) => refreshedCookies.get(request);
const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
export async function digest(value: string) {
  return hex(await crypto.subtle.digest("SHA-256", encode.encode(value)));
}
export async function hashPassword(
  password: string,
  salt = crypto.randomUUID(),
) {
  const key = await crypto.subtle.importKey(
    "raw",
    encode.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const hash = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: encode.encode(salt),
      iterations: 100000,
    },
    key,
    256,
  );
  return `pbkdf2:100000:${salt}:${hex(hash)}`;
}
export async function verifyPassword(password: string, stored: string) {
  const parts = stored.split(":");
  if (parts[0] !== "pbkdf2" || parts[1] !== "100000" || parts.length !== 4)
    return false;
  const candidate = await hashPassword(password, parts[2]);
  let diff = candidate.length ^ stored.length;
  for (let i = 0; i < stored.length; i++)
    diff |= (candidate.charCodeAt(i) || 0) ^ stored.charCodeAt(i);
  return diff === 0;
}
export function sessionToken(request: Request) {
  return request.headers
    .get("cookie")
    ?.split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith("cet_session="))
    ?.slice(12);
}
export async function currentUser(
  request: Request,
  env: Env,
): Promise<User | null> {
  const token = sessionToken(request);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const db = env.AUTH_DB || env.DB;
  const tokenHash = await digest(token);
  const now = Date.now();
  const session = await db.prepare(
    "SELECT u.id,u.name,u.email,s.expires_at AS expiresAt FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?",
  )
    .bind(tokenHash, now)
    .first<User & { expiresAt: number }>();
  const user: User | null = session ? { id: session.id, name: session.name, email: session.email } : null;
  if (session && session.expiresAt < now + (SESSION_AGE_SECONDS - 86400) * 1000) {
    await db.prepare("UPDATE sessions SET expires_at=MAX(expires_at,?) WHERE token_hash=? AND expires_at>?")
      .bind(now + SESSION_AGE_SECONDS * 1000, tokenHash, now).run();
    refreshedCookies.set(request, sessionCookie(request, token));
  }
  if (session && request.method === "GET" && new URL(request.url).pathname === "/api/auth" && !refreshedCookies.has(request)) {
    refreshedCookies.set(request, sessionCookie(request, token, Math.max(1, Math.floor((session.expiresAt - now) / 1000))));
  }
  if (user && env.AUTH_DB) {
    // Local rows only own this site's practice data; credentials live in AUTH_DB.
    await env.DB.prepare(
      "INSERT INTO users(id,email,name,password,created_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email,name=excluded.name",
    ).bind(user.id, user.email, user.name, "!shared-identity", new Date().toISOString()).run();
  }
  return user;
}
export async function requireUser(request: Request, env: Env) {
  const user = await currentUser(request, env);
  if (!user)
    throw new HttpError(401, "请先使用邮箱登录，再开始练习、上传、批改或向 AI 老师提问。", "LOGIN_REQUIRED");
  return user;
}
export function sessionCookie(request: Request, token: string, age = SESSION_AGE_SECONDS) {
  return `cet_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}; Expires=${new Date(Date.now() + age * 1000).toUTCString()}${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`;
}
export async function createSession(request: Request, env: Env, id: string) {
  const db = env.AUTH_DB || env.DB;
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE expires_at<?").bind(Date.now()),
    db.prepare(
      "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
    ).bind(await digest(token), id, Date.now() + SESSION_AGE_SECONDS * 1000),
  ]);
  return sessionCookie(request, token);
}
export async function destroySession(request: Request, env: Env) {
  const token = sessionToken(request);
  if (token)
    await (env.AUTH_DB || env.DB).prepare("DELETE FROM sessions WHERE token_hash=?")
      .bind(await digest(token))
      .run();
  return sessionCookie(request, "", 0);
}
export async function rateLimit(
  env: Env,
  key: string,
  maximum: number,
  windowMs: number,
) {
  const now = Date.now();
  const row = await env.DB.prepare(
    "INSERT INTO rate_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires_at<? THEN 1 ELSE count+1 END,expires_at=CASE WHEN expires_at<? THEN ? ELSE expires_at END RETURNING count",
  )
    .bind(await digest(key), now + windowMs, now, now, now + windowMs)
    .first<{ count: number }>();
  if ((row?.count || 0) > maximum)
    throw new HttpError(429, "操作过于频繁，请稍后再试。", "RATE_LIMITED");
}
