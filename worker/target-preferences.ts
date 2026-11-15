import { z } from "zod";
import { assertOrigin, body, HttpError } from "../src/lib/http";
import { requireUser } from "./auth";
import type { Env } from "./types";

export type TargetPreference = { ownerId: string; target: number | null; version: number; updatedAt: string | null };
type Row = { target: number; version: number; updatedAt: string };
const inputSchema = z.object({
  ownerId: z.string().min(1).max(200),
  target: z.number().int().min(1).max(15),
  expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const select = "SELECT target,version,updated_at AS updatedAt FROM account_target_preferences WHERE user_id=?";
const result = (ownerId: string, row: Row | null): TargetPreference => ({ ownerId, target: row?.target ?? null, version: row?.version ?? 0, updatedAt: row?.updatedAt ?? null });

/** Account-owned preference, stored separately from all practice inputs. No TTL. */
export async function targetPreferenceRoute(request: Request, env: Env): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/api/preferences/target") return null;
  if (!["GET", "PUT"].includes(request.method)) throw new HttpError(405, "请求方式不支持。");
  if (request.method === "PUT") assertOrigin(request);
  const user = await requireUser(request, env);
  if (request.method === "GET") return json(result(user.id, await env.DB.prepare(select).bind(user.id).first<Row>()));
  const data = inputSchema.parse(await body(request, 2500));
  // A request queued under another login may carry a new account's cookie.
  // Only authenticated identity selects the row; the supplied ID is a fence.
  if (data.ownerId !== user.id) throw new HttpError(403, "账号已切换，请重新读取当前账号的目标分。", "TARGET_PREFERENCE_OWNER_CHANGED");
  const current = await env.DB.prepare(select).bind(user.id).first<Row>();
  if (current?.target === data.target) return json(result(user.id, current));
  const now = new Date().toISOString();
  const written = data.expectedVersion === 0
    ? await env.DB.prepare("INSERT INTO account_target_preferences(user_id,target,version,updated_at) VALUES(?,?,1,?) ON CONFLICT(user_id) DO NOTHING RETURNING target,version,updated_at AS updatedAt").bind(user.id, data.target, now).first<Row>()
    : await env.DB.prepare("UPDATE account_target_preferences SET target=?,version=version+1,updated_at=? WHERE user_id=? AND version=? RETURNING target,version,updated_at AS updatedAt").bind(data.target, now, user.id, data.expectedVersion).first<Row>();
  if (written) return json(result(user.id, written));
  const latest = await env.DB.prepare(select).bind(user.id).first<Row>();
  if (latest?.target === data.target) return json(result(user.id, latest));
  return json({ error: "目标分已在其他设备更新。", code: "TARGET_PREFERENCE_CONFLICT", preference: result(user.id, latest) }, 409);
}
