import { test } from "node:test";
import assert from "node:assert/strict";
import { sqliteDatabase } from "../server/database";
import { digest } from "../worker/auth";
import { finishReviewAccounting, getLeaderboard, recordReviewPoints, shanghaiDay, withLeaderboard } from "../worker/leaderboard";
import worker from "../worker/index";
import type { Env } from "../worker/types";
import { ensureMembership } from "../worker/membership";

const SCORE_KEY = "holisticScore";
const SCORE = 11, REVISED = 12, MAX = 15;
const now = new Date("2026-10-29T16:20:00.000Z");
function setup() {
  const { db, sql } = sqliteDatabase(":memory:");
  const env = { DB: db, ASSETS: { fetch: async () => new Response("asset") } } as Env;
  for (const [id,name] of [["alice", "小林"], ["bob", "小周"], ["zero", "private@example.test"]])
    sql.prepare("INSERT INTO users(id,name,email,password,created_at) VALUES(?,?,?,?,?)").run(id, name, id + "@example.test", "not-a-password", "2026-10-01T00:00:00.000Z");
  function review(id: string, owner: string, score: number | null, essay = "First private answer.", date = "2026-10-29T16:00:00.000Z", questionId = 11723, status = "completed", scope = "full") {
    const input = { questionId, essay, title: id, targetBand: id.includes("duplicate") ? 9 : 7 };
    const feedback = { [SCORE_KEY]: score, assessmentScope: scope };
    sql.prepare("INSERT INTO reviews(id,user_id,input,question,status,feedback,model,refs,request_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, owner, JSON.stringify(input), JSON.stringify({ id: questionId, task: "writing", examType: "A", stem: "Private prompt." }), status, JSON.stringify(feedback), "test", "[]", id, date);
  }
  const request = () => new Request("https://writing.example/api/leaderboard");
  return { db, sql, env, review, request };
}

test("Beijing daily boundaries cross UTC dates without local-host timezone dependence", () => {
  assert.deepEqual(shanghaiDay(now), { date: "2026-10-30", start: "2026-10-29T16:00:00.000Z", end: "2026-10-30T16:00:00.000Z" });
  assert.equal(shanghaiDay(new Date("2026-10-29T15:59:59.999Z")).date, "2026-10-29");
});

test("VIP plates use shared current entitlements without changing ranks or exposing expiry", async t => {
  const f = setup(), identity = sqliteDatabase(":memory:");
  t.after(() => { f.sql.close(); identity.sql.close(); });
  const env = { ...f.env, AUTH_DB: identity.db, MEMBERSHIP_ENABLED: "true", MEMBERSHIP_LAUNCH_DEFERRED: "true" } as Env;
  for (const id of ["alice", "bob", "zero"])
    identity.sql.prepare("INSERT INTO users(id,name,email,password,created_at) VALUES(?,?,?,?,?)").run(id, id, id + "@example.test", "!test", now.toISOString());
  await ensureMembership(env);
  identity.sql.prepare("INSERT INTO membership_accounts(user_id,expires_at,referral_code) VALUES(?,?,?)").run("alice", now.getTime(), "EXPIRED");
  identity.sql.prepare("INSERT INTO membership_accounts(user_id,expires_at,referral_code) VALUES(?,?,?)").run("bob", now.getTime() + 1000, "ACTIVE");
  identity.sql.prepare("INSERT INTO membership_permanent(user_id,granted_at) VALUES(?,?)").run("zero", now.getTime());
  for (const id of ["alice", "bob", "zero"]) f.review("vip-" + id, id, SCORE);
  const result = await getLeaderboard(f.request(), env, now);
  for (const entries of [result.daily, result.total]) {
    assert.deepEqual(entries.map(entry => entry.rank), [1, 1, 1]);
    assert.equal(entries.find(entry => entry.name === "小林")!.isVip, false);
    assert.equal(entries.find(entry => entry.name === "小周")!.isVip, true);
    assert.equal(entries.find(entry => entry.name === "练习同学")!.isVip, true);
  }
  const later = await getLeaderboard(f.request(), env, new Date(now.getTime() + 1000));
  assert.equal(later.total.find(entry => entry.name === "小周")!.isVip, false);
  assert.equal(later.total.find(entry => entry.name === "练习同学")!.isVip, true);
  const json = JSON.stringify(result);
  for (const privateField of ["expires_at", "expiresAt", "granted_at", "referral_code", "EXPIRED", "ACTIVE"])
    assert.ok(!json.includes(privateField));
});

test("scores add per distinct answer, dedupe across days, and keep daily and total ranks separate", async t => {
  const f = setup(); t.after(() => f.sql.close());
  f.review("a-before", "alice", SCORE, "First private answer.", "2026-10-29T15:59:59.999Z");
  f.review("a-duplicate", "alice", MAX, " First  private\nanswer. ");
  f.review("a-revised", "alice", REVISED, "A changed private answer.");
  f.review("a-new-question", "alice", SCORE, "First private answer.", undefined, 11725);
  f.review("b-one", "bob", MAX); f.review("b-two", "bob", MAX, "Another private answer.");
  f.review("zero", "zero", 0);
  f.review("failed", "alice", MAX, "Failed answer.", undefined, 11723, "failed");
  f.review("limited", "alice", MAX, "Limited answer.", undefined, 11723, "completed", "language_only");
  f.review("unscored", "alice", null, "Unscored answer.");
  f.review("invalid", "alice", 999, "Invalid feedback.");
  f.review("future", "alice", MAX, "Tomorrow's answer.", "2026-10-30T16:00:00.000Z");
  const result = await getLeaderboard(f.request(), f.env, now);
  const aliceTotal = result.total.find(r => r.name === "小林")!, aliceDaily = result.daily.find(r => r.name === "小林")!;
  assert.equal(aliceTotal.points, SCORE * 2 + REVISED + MAX);
  assert.equal(aliceTotal.attempts, 4);
  assert.equal(aliceDaily.points, SCORE + REVISED); assert.equal(aliceDaily.attempts, 2);
  assert.equal(result.daily[0].name, "小周"); assert.equal(result.daily[0].points, MAX * 2);
  assert.equal(result.total[0].name, "小林");
  assert.equal(result.mine, null);
  assert.equal(result.daily.find(r => r.name === "练习同学")?.points, 0);
  const json = JSON.stringify(result);
  for (const privateValue of ["private@example.test", "alice@example.test", "First private answer", "Private prompt", "user_id", "fingerprint", "a-revised"])
    assert.ok(!json.includes(privateValue), "Public rankings must not disclose " + privateValue);
  const again = await Promise.all([getLeaderboard(f.request(), f.env, now), getLeaderboard(f.request(), f.env, now)]);
  assert.deepEqual(again[0], result); assert.deepEqual(again[1], result);
});

test("newly completed reviews award on completion, retries cannot double count, and self summary is authenticated", async t => {
  const f = setup(); t.after(() => f.sql.close());
  f.review("completed-late", "alice", SCORE, "Late completion.", "2026-10-29T15:59:00.000Z");
  await recordReviewPoints(f.env, "completed-late", now);
  await recordReviewPoints(f.env, "completed-late", new Date(now.getTime() + 1000));
  f.review("peer", "bob", SCORE);
  const token = "a".repeat(64);
  f.sql.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)").run(await digest(token), "alice", Date.now() + 60_000);
  const request = new Request("https://writing.example/api/leaderboard", { headers: { Cookie: "cet_session=" + token } });
  const result = await getLeaderboard(request, f.env, now);
  assert.deepEqual(result.mine?.daily, { rank: 1, points: SCORE, attempts: 1 });
  assert.deepEqual(result.mine?.total, { rank: 1, points: SCORE, attempts: 1 });
  assert.equal(result.daily.filter(r => r.rank === 1).length, 2);
  assert.equal(result.daily.filter(r => r.isMe).length, 1);
  assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM leaderboard_receipts WHERE review_id='completed-late'").get()!.n, 1);
  const anonymous = await getLeaderboard(new Request("https://writing.example/api/leaderboard?userId=alice"), f.env, now);
  assert.equal(anonymous.mine, null); assert.ok(anonymous.daily.every(r => !r.isMe));
});

test("daily, total and personal ranks skip occupied places after tied scores", async t => {
  const f = setup(); t.after(() => f.sql.close());
  const scores = [15, 14, 13, 12, 11, 10, 10, 9];
  for (const [index, score] of scores.entries()) {
    const id = `place-${index}`;
    f.sql.prepare("INSERT INTO users(id,name,email,password,created_at) VALUES(?,?,?,?,?)").run(id, id, id + "@example.test", "not-a-password", "2026-10-01T00:00:00.000Z");
    f.review(`rank-${index}`, id, score);
  }
  const token = "b".repeat(64);
  f.sql.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)").run(await digest(token), "place-7", Date.now() + 60000);
  const request = new Request("https://writing.example/api/leaderboard", { headers: { Cookie: "cet_session=" + token } });
  const result = await getLeaderboard(request, f.env, now);
  for (const board of [result.daily, result.total]) {
    assert.deepEqual(board.map(row => row.rank), [1, 2, 3, 4, 5, 6, 6, 8]);
    assert.deepEqual(board.map(row => row.points), scores);
  }
  assert.equal(result.mine?.daily.rank, 8);
  assert.equal(result.mine?.total.rank, 8);
});

test("public API is read-only, and review responses keep their original body", async t => {
  const f = setup(); t.after(() => f.sql.close());
  const response = await worker.fetch(f.request(), f.env);
  assert.equal(response.status, 200); assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal((await worker.fetch(new Request("https://writing.example/api/leaderboard", { method: "POST" }), f.env)).status, 405);
  assert.equal((await worker.fetch(new Request("https://writing.example/api/reviews"), f.env)).status, 401);
  f.review("new-review", "alice", SCORE);
  const body = JSON.stringify({ review: { id: "new-review", status: "completed", feedback: { [SCORE_KEY]: SCORE } } });
  const original = new Response(body, { headers: { "Content-Type": "application/json" } });
  const wrapped = await withLeaderboard(new Request("https://writing.example/api/reviews", { method: "POST" }), f.env, async () => original);
  assert.equal(await wrapped.text(), body);
  assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM leaderboard_receipts WHERE review_id='new-review'").get()!.n, 1);
});

test("opening an old report or retrying its request cannot earn new daily points", async t => {
  const f = setup(); t.after(() => f.sql.close());
  f.review("old-report", "alice", SCORE, "Previously completed answer.", "2026-10-29T15:00:00.000Z");
  const result = () => Promise.resolve(Response.json({ review: { id: "old-report", status: "completed" } }));
  await withLeaderboard(new Request("https://writing.example/api/reviews?id=old-report"), f.env, result);
  await withLeaderboard(new Request("https://writing.example/api/reviews", { method: "POST" }), f.env, result);
  const board = await getLeaderboard(f.request(), f.env, now);
  assert.equal(board.daily.length, 0); assert.equal(board.total[0].points, SCORE);
});

test("a review submitted before midnight earns points on completion after midnight", async t => {
  const f = setup(); t.after(() => f.sql.close());
  f.review("midnight", "alice", null, "Answer completed across midnight.", "2026-10-29T15:59:00.000Z", 11723, "processing");
  await finishReviewAccounting(f.env, "alice", "midnight", { [SCORE_KEY]: SCORE, assessmentScope: "full" }, undefined, now);
  assert.equal(f.sql.prepare("SELECT status FROM reviews WHERE id='midnight'").get()!.status, "completed");
  assert.equal((await getLeaderboard(f.request(), f.env, now)).daily[0].points, SCORE);
  await finishReviewAccounting(f.env, "alice", "midnight", { [SCORE_KEY]: MAX, assessmentScope: "full" }, undefined, new Date(now.getTime() + 86400_000));
  assert.equal((await getLeaderboard(f.request(), f.env, new Date(now.getTime() + 86400_000))).daily.length, 0);
});

