import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import { assertOrigin, body, HttpError } from "../src/lib/http";
import { practiceSentences, sentenceGaps, wordMatches } from "../src/lib/sentence-practice";
import { currentUser, rateLimit, requireUser } from "./auth";
import type { Env } from "./types";

const initialized = new WeakMap<D1Database, Promise<unknown>>();
export async function ensureSentencePractice(db: D1Database) {
  if (!initialized.has(db)) {
    const promise = db.batch([
      db.prepare("CREATE TABLE IF NOT EXISTS translation_sentence_completions(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,sentence_id TEXT NOT NULL,awarded_at TEXT NOT NULL,PRIMARY KEY(user_id,sentence_id))"),
      db.prepare("CREATE INDEX IF NOT EXISTS translation_sentence_awarded ON translation_sentence_completions(awarded_at)"),
    ]).catch(error => { initialized.delete(db); throw error; });
    initialized.set(db, promise);
  }
  await initialized.get(db);
}
export async function sentenceProgress(env: Env, owner?: string, now = new Date()) {
  await ensureSentencePractice(env.DB);
  if (!owner) return { completed: [] as string[], points: 0, todayPoints: 0 };
  const rows = (await env.DB.prepare("SELECT sentence_id,awarded_at FROM translation_sentence_completions WHERE user_id=? ORDER BY awarded_at,sentence_id").bind(owner).all<{sentence_id:string;awarded_at:string}>()).results;
  const day = new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0,10);
  return { completed: rows.map(row => row.sentence_id), points: rows.length, todayPoints: rows.filter(row => new Date(new Date(row.awarded_at).getTime() + 8 * 3600_000).toISOString().slice(0,10) === day).length };
}
const answerSchema = z.object({ sentenceId: z.string().max(80), hintSeed: z.string().regex(/^[a-f0-9]{32}$/i).optional(), answers: z.array(z.string().max(80)).max(80) }).strict();
export async function completeSentence(env: Env, owner: string, data: z.infer<typeof answerSchema>, now = new Date()) {
  const sentence = practiceSentences.find(row => row.id === data.sentenceId);
  if (!sentence) throw new HttpError(404, "这句话暂未收录，请换一句。");
  const expected = sentenceGaps(sentence.english, data.hintSeed);
  const incorrect = expected.flatMap((word, index) => wordMatches(data.answers[index] || "", word) ? [] : [index]);
  if (incorrect.length || data.answers.length !== expected.length) return { passed: false, awarded: false, incorrect };
  await ensureSentencePractice(env.DB);
  const result = await env.DB.prepare("INSERT OR IGNORE INTO translation_sentence_completions(user_id,sentence_id,awarded_at) VALUES(?,?,?)").bind(owner,sentence.id,now.toISOString()).run();
  return { passed: true, awarded: Number(result.meta.changes) === 1, incorrect: [], ...await sentenceProgress(env, owner, now) };
}
export async function sentencePracticeRoute(request: Request, env: Env) {
  const path = new URL(request.url).pathname;
  if (path !== "/api/sentence-practice" && path !== "/api/sentence-practice/complete") return null;
  if (path === "/api/sentence-practice") {
    if (request.method !== "GET") throw new HttpError(405, "请求方式不支持。");
    return Response.json(await sentenceProgress(env,(await currentUser(request,env))?.id),{headers:{"Cache-Control":"no-store"}});
  }
  if (request.method !== "POST") throw new HttpError(405, "请求方式不支持。");
  assertOrigin(request);
  const user = await requireUser(request,env);
  await rateLimit(env,"sentence-complete:"+user.id,30,60_000);
  return Response.json(await completeSentence(env,user.id,answerSchema.parse(await body(request,10000))),{headers:{"Cache-Control":"no-store"}});
}
