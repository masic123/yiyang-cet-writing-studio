import type { D1Database } from "@cloudflare/workers-types";
import type { LeaderboardData, LeaderboardEntry, LeaderboardSummary } from "../src/lib/leaderboard-types";
import { currentUser, digest } from "./auth";
import { HttpError } from "../src/lib/http";
import type { Env } from "./types";
import { questions } from "../src/lib/content";
import { ensureSentencePractice } from "./sentence-practice";
import type { QuestionStatsData } from "../src/lib/question-stats-types";
import { activeMembershipIds } from "./membership";

const SCORE_KEY = "holisticScore";
const MAX_SCORE = 15;
const SCORE_MULTIPLIER = 1;
const initialized = new WeakMap<D1Database, Promise<unknown>>();
const syncing = new WeakMap<D1Database, Promise<void>>();
type ReviewRow = { id: string; user_id: string; input: string; question: string; feedback: string; created_at: string };

export function shanghaiDay(now = new Date()) {
  const date = new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
  const start = new Date(date + "T00:00:00+08:00");
  return { date, start: start.toISOString(), end: new Date(start.getTime() + 86400_000).toISOString() };
}

async function ensureSchema(db: D1Database) {
  if (!initialized.has(db)) {
    const init = db.batch([
      db.prepare("CREATE TABLE IF NOT EXISTS leaderboard_receipts(review_id TEXT PRIMARY KEY REFERENCES reviews(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,fingerprint TEXT NOT NULL,points_units INTEGER,awarded_at TEXT NOT NULL)"),
      db.prepare("CREATE INDEX IF NOT EXISTS leaderboard_owner_answer ON leaderboard_receipts(user_id,fingerprint,awarded_at,review_id)"),
      db.prepare("CREATE INDEX IF NOT EXISTS leaderboard_awarded ON leaderboard_receipts(awarded_at)")
    ]).catch(error => { initialized.delete(db); throw error; });
    initialized.set(db, init);
  }
  await initialized.get(db);
  await ensureSentencePractice(db);
}

const normalize = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim();
async function receipt(db: D1Database, row: ReviewRow, awardedAt: string) {
  let fingerprint = await digest("unscored:" + row.id);
  let units: number | null = null;
  try {
    const input = JSON.parse(row.input), question = JSON.parse(row.question), feedback = JSON.parse(row.feedback);
    const score = feedback?.[SCORE_KEY];
    if (typeof input?.essay === "string" && input.essay.trim() && feedback.assessmentScope === "full" && typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= MAX_SCORE && Number.isInteger(score * SCORE_MULTIPLIER)) {
      const topic = Number.isInteger(input.questionId) && input.questionId > 0
        ? ["bank", input.questionId]
        : ["custom", question.task, question.examType, normalize(question.stem || ""), normalize(question.sourceText || ""), input.customQuestion?.chartData || "", normalize(input.customQuestion?.visualDescription || "")];
      fingerprint = await digest(JSON.stringify([topic, normalize(input.essay)]));
      units = Math.round(score * 2);
    }
  } catch { /* Old malformed or unscored feedback cannot earn points. */ }
  return db.prepare("INSERT OR IGNORE INTO leaderboard_receipts(review_id,user_id,fingerprint,points_units,awarded_at) VALUES(?,?,?,?,?)")
    .bind(row.id, row.user_id, fingerprint, units, awardedAt);
}

/** The receipt records every completed review; ranking credits only the first identical answer. */
export async function recordReviewPoints(env: Env, reviewId: string, now = new Date()) {
  await ensureSchema(env.DB);
  const row = await env.DB.prepare("SELECT id,user_id,input,question,feedback,created_at FROM reviews WHERE id=? AND status='completed'").bind(reviewId).first<ReviewRow>();
  if (row) await (await receipt(env.DB, row, now.toISOString())).run();
}

/** Commit the score and its completion timestamp together, including across Beijing midnight. */
export async function finishReviewAccounting(env: Env, owner: string, id: string, feedback: object | null, error?: string, now = new Date()) {
  const update = env.DB.prepare("UPDATE reviews SET status=?,feedback=?,error=? WHERE id=? AND user_id=? AND status='processing'")
    .bind(feedback ? "completed" : "failed", feedback ? JSON.stringify(feedback) : null, error || null, id, owner);
  let award;
  if (feedback) {
    try {
      await ensureSchema(env.DB);
      const row = await env.DB.prepare("SELECT id,user_id,input,question,feedback,created_at FROM reviews WHERE id=? AND user_id=? AND status='processing'").bind(id, owner).first<ReviewRow>();
      if (row) award = await receipt(env.DB, { ...row, feedback: JSON.stringify(feedback) }, now.toISOString());
    } catch { console.warn("Leaderboard receipt deferred; review will still be saved."); }
  }
  if (award) {
    try { await env.DB.batch([update, award]); }
    catch { await update.run(); console.warn("Leaderboard receipt deferred; review was saved."); }
  } else await update.run();
}

async function syncHistory(env: Env) {
  if (!syncing.has(env.DB)) {
    const task = (async () => {
      await ensureSchema(env.DB);
      for (;;) {
        const rows = (await env.DB.prepare("SELECT r.id,r.user_id,r.input,r.question,r.feedback,r.created_at FROM reviews r LEFT JOIN leaderboard_receipts l ON l.review_id=r.id WHERE r.status='completed' AND l.review_id IS NULL ORDER BY r.created_at,r.id LIMIT 100").all<ReviewRow>()).results;
        if (!rows.length) break;
        // Existing reports predate the ledger; their saved submission date is the historical timestamp.
        await env.DB.batch(await Promise.all(rows.map(row => receipt(env.DB, row, row.created_at))));
      }
    })().finally(() => syncing.delete(env.DB));
    syncing.set(env.DB, task);
  }
  await syncing.get(env.DB);
}

function rankingSql(daily: boolean) {
  return `WITH answers AS (
    SELECT *,ROW_NUMBER() OVER(PARTITION BY user_id,fingerprint ORDER BY awarded_at,review_id) AS duplicate_order
    FROM leaderboard_receipts WHERE points_units IS NOT NULL
  ), credits AS (
    SELECT user_id,points_units,awarded_at FROM answers WHERE duplicate_order=1
    UNION ALL SELECT user_id,2 AS points_units,awarded_at FROM translation_sentence_completions
  ), scores AS (
    SELECT user_id,SUM(points_units) AS units,COUNT(*) AS attempts FROM credits
    ${daily ? "WHERE awarded_at>=? AND awarded_at<?" : ""} GROUP BY user_id
  ), ranked AS (
    SELECT *,RANK() OVER(ORDER BY units DESC) AS rank FROM scores
  ) SELECT r.*,u.name FROM ranked r JOIN users u ON u.id=r.user_id`;
}
type RankedRow = { user_id: string; name: string; units: number; attempts: number; rank: number };
const summary = (r: RankedRow | null): LeaderboardSummary => ({ rank: r ? Number(r.rank) : null, points: r ? Number(r.units) / 2 : 0, attempts: r ? Number(r.attempts) : 0 });
function publicName(name: string) {
  const value = String(name || "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return !value || value.includes("@") ? "练习同学" : value.slice(0, 40);
}

export async function getLeaderboard(request: Request, env: Env, now = new Date()): Promise<LeaderboardData> {
  await syncHistory(env);
  const user = await currentUser(request, env);
  const day = shanghaiDay(now);
  async function board(daily: boolean) {
    const values = daily ? [day.start, day.end] : [];
    const rows = (await env.DB.prepare(rankingSql(daily) + " ORDER BY r.units DESC,r.attempts DESC,r.user_id").bind(...values).all<RankedRow>()).results;
    const mine = user ? await env.DB.prepare(rankingSql(daily) + " WHERE r.user_id=?").bind(...values, user.id).first<RankedRow>() : null;
    return { rows, mine: summary(mine) };
  }
  const [daily, total] = await Promise.all([board(true), board(false)]);
  const vipIds = await activeMembershipIds(env, [...new Set([...daily.rows, ...total.rows].map(row => row.user_id))], now.getTime());
  const entries = (rows: RankedRow[]): LeaderboardEntry[] => rows.map(r => ({ ...summary(r), rank: Number(r.rank), name: publicName(r.name), isMe: r.user_id === user?.id, isVip: vipIds.has(r.user_id) }));
  return { date: day.date, timezone: "Asia/Shanghai", daily: entries(daily.rows), total: entries(total.rows), mine: user ? { daily: daily.mine, total: total.mine } : null };
}

/** A learner contributes only their earliest scored submission to each bank question. */
export async function getQuestionStats(env: Env): Promise<QuestionStatsData> {
  await syncHistory(env);
  const rows = (await env.DB.prepare(`WITH scored AS (
    SELECT r.user_id,r.id,r.created_at,l.points_units,
      CASE WHEN json_valid(r.input) THEN r.input ELSE '{}' END AS input
    FROM reviews r JOIN leaderboard_receipts l ON l.review_id=r.id
    WHERE r.status='completed' AND l.points_units IS NOT NULL
  ), attempts AS (
    SELECT json_extract(input,'$.questionId') AS question_id,points_units,
      ROW_NUMBER() OVER(PARTITION BY user_id,json_extract(input,'$.questionId') ORDER BY created_at,id) AS attempt_order
    FROM scored WHERE json_type(input,'$.questionId')='integer' AND json_extract(input,'$.questionId')>0
  ) SELECT question_id,COUNT(*) AS participants,AVG(points_units)/2 AS average_score
    FROM attempts WHERE attempt_order=1 GROUP BY question_id ORDER BY question_id`).all<{ question_id: number; participants: number; average_score: number }>()).results;
  const known = new Set(questions().map(q => q.id));
  return { maxScore: MAX_SCORE, stats: rows.filter(r => known.has(r.question_id)).map(r => ({ questionId: Number(r.question_id), participants: Number(r.participants), averageScore: Math.round(Number(r.average_score) * 10) / 10 })) };
}

/** Keep points accounting outside assessment so a ranking failure never loses a review. */
export async function withLeaderboard(request: Request, env: Env, next: () => Promise<Response>) {
  const url = new URL(request.url);
  if (url.pathname === "/api/question-stats") {
    if (request.method !== "GET") throw new HttpError(405, "请求方式不支持。");
    return Response.json(await getQuestionStats(env), { headers: { "Cache-Control": "no-store" } });
  }
  if (url.pathname === "/api/leaderboard") {
    if (request.method !== "GET") throw new HttpError(405, "请求方式不支持。");
    return Response.json(await getLeaderboard(request, env), { headers: { "Cache-Control": "no-store" } });
  }
  const isSubmission = url.pathname === "/api/reviews" && request.method === "POST";
  if (isSubmission) {
    // Backfill older completions before an idempotent retry can encounter them.
    try { await syncHistory(env); }
    catch { console.warn("Leaderboard history deferred; assessment remains available."); }
  }
  const response = await next();
  if (response.ok && isSubmission) {
    try {
      const { review } = await response.clone().json() as { review?: { id: string; status: string } };
      if (review?.status === "completed") await recordReviewPoints(env, review.id);
    } catch { console.warn("Leaderboard accounting deferred; saved review is preserved."); }
  }
  return response;
}

