import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { sqliteDatabase } from "../server/database";
import { digest } from "../worker/auth";
import { getLeaderboard, shanghaiDay } from "../worker/leaderboard";
import { ensureMembership } from "../worker/membership";
import worker from "../worker/index";
import type { Env } from "../worker/types";
import type { LeaderboardData } from "../src/lib/leaderboard-types";

const now = new Date("2026-11-02T06:00:00.000Z");

async function fixture(t: TestContext, count: number) {
  const app = sqliteDatabase(":memory:");
  const identity = sqliteDatabase(":memory:");
  t.after(() => { app.sql.close(); identity.sql.close(); });
  const env = {
    DB: app.db, AUTH_DB: identity.db,
    MEMBERSHIP_ENABLED: "true", MEMBERSHIP_LAUNCH_DEFERRED: "true",
    ASSETS: { fetch: async () => new Response("asset") },
  } as Env;
  const id = (index: number) => `private-account-${String(index).padStart(3, "0")}`;
  const name = (index: number) => `同学${String(index + 1).padStart(3, "0")}`;
  for (let index = 0; index < count; index++) {
    for (const database of [app, identity]) {
      database.sql.prepare("INSERT INTO users(id,name,email,password,created_at) VALUES(?,?,?,?,?)")
        .run(id(index), name(index), `private-email-${index}@example.test`, "!synthetic-private-password", "2026-10-01T00:00:00.000Z");
    }
  }
  await ensureMembership(env);
  let nextReview = 0;
  function points(index: number, total: number, date = now) {
    let remaining = total;
    do {
      const score = Math.min(15, remaining);
      const reviewId = `private-review-${nextReview++}`;
      const input = { questionId: 11723, essay: `Private answer ${reviewId}.`, title: reviewId, targetScore: 11 };
      app.sql.prepare("INSERT INTO reviews(id,user_id,input,question,status,feedback,model,refs,request_key,created_at) VALUES(?,?,?,?,'completed',?,'synthetic','[]',?,?)")
        .run(reviewId, id(index), JSON.stringify(input), JSON.stringify({ id: 11723, task: "writing", examType: "CET6", stem: "Private question content." }), JSON.stringify({ holisticScore: score, assessmentScope: "full" }), reviewId, date.toISOString());
      remaining -= score;
    } while (remaining > 0);
  }
  function activeVip(index: number, expiresAt: number) {
    identity.sql.prepare("INSERT INTO membership_accounts(user_id,expires_at,referral_code) VALUES(?,?,?)")
      .run(id(index), expiresAt, `PRIVATE-REFERRAL-${index}`);
  }
  function permanentVip(index: number) {
    identity.sql.prepare("INSERT INTO membership_permanent(user_id,granted_at) VALUES(?,?)").run(id(index), now.getTime());
  }
  async function request(owner?: number) {
    const headers = new Headers();
    if (owner !== undefined) {
      const token = (owner % 2 ? "c" : "d").repeat(64);
      identity.sql.prepare("INSERT OR REPLACE INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)")
        .run(await digest(token), id(owner), Date.now() + 600_000);
      headers.set("Cookie", `cet_session=${token}`);
    }
    return new Request("https://writing.example/api/leaderboard", { headers });
  }
  return { app, identity, env, id, name, points, activeVip, permanentVip, request };
}

test("full daily and total boards keep tied places across row 20 and include an authenticated learner beyond row 21", async t => {
  const scores = [30, 29, 28, 27, 26, 25, 24, 24, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 11, 11, 8, 8, 6, 5, 4, 3, 2, 1, 0];
  const ranks = [1, 2, 3, 4, 5, 6, 7, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 20, 20, 23, 23, 25, 26, 27, 28, 29, 30, 31];
  const f = await fixture(t, scores.length);
  scores.forEach((score, index) => f.points(index, score));
  f.activeVip(25, now.getTime() + 60_000);
  f.activeVip(26, now.getTime());
  f.permanentVip(30);
  const result = await getLeaderboard(await f.request(25), f.env, now);
  for (const board of [result.daily, result.total]) {
    assert.equal(board.length, scores.length);
    assert.deepEqual(board.map(entry => entry.points), scores);
    assert.deepEqual(board.map(entry => entry.rank), ranks);
    assert.deepEqual(board.map(entry => entry.name), scores.map((_, index) => f.name(index)));
    assert.equal(board[25].isMe, true);
    assert.equal(board[25].rank, 26);
    assert.equal(board[25].isVip, true);
    assert.equal(board[26].isVip, false);
    assert.equal(board[30].isVip, true);
    assert.equal(board.filter(entry => entry.isMe).length, 1);
    assert.deepEqual(board.slice(19, 25).map(entry => entry.rank), [20, 20, 20, 23, 23, 25]);
  }
  assert.deepEqual(result.mine?.daily, { rank: 26, points: 5, attempts: 1 });
  assert.deepEqual(result.mine?.total, { rank: 26, points: 5, attempts: 1 });
});

test("full boards cross both the 100-review history batch and every 80-owner VIP lookup batch", async t => {
  const f = await fixture(t, 170);
  for (let index = 0; index < 170; index++) f.points(index, 1);
  const activeIndices = [0, 79, 80, 159, 160];
  for (const index of activeIndices) f.activeVip(index, now.getTime() + 60_000);
  f.activeVip(168, now.getTime());
  f.permanentVip(169);
  const result = await getLeaderboard(await f.request(169), f.env, now);
  for (const board of [result.daily, result.total]) {
    assert.equal(board.length, 170);
    assert.ok(board.every(entry => entry.rank === 1 && entry.points === 1 && entry.attempts === 1));
    for (const index of [...activeIndices, 169]) assert.equal(board[index].isVip, true, `VIP badge missing at row ${index + 1}`);
    assert.equal(board[168].isVip, false);
    assert.equal(board.filter(entry => entry.isVip).length, 6);
    assert.equal(board[169].isMe, true);
    assert.equal(board.filter(entry => entry.isMe).length, 1);
  }
  assert.equal(f.app.sql.prepare("SELECT count(*) AS n FROM leaderboard_receipts").get()!.n, 170);
  assert.deepEqual(result.mine?.daily, { rank: 1, points: 1, attempts: 1 });
  assert.deepEqual(result.mine?.total, { rank: 1, points: 1, attempts: 1 });
});

test("each Beijing day returns all its participants while the total board includes every credited learner", async t => {
  const f = await fixture(t, 59);
  const yesterday = new Date(now.getTime() - 86400_000);
  for (let index = 0; index < 31; index++) f.points(index, 5);
  for (let index = 31; index < 58; index++) f.points(index, 7, yesterday);
  for (let index = 0; index < 11; index++) f.points(index, 3, yesterday);
  // Account 58 has never earned a score and must not be added merely because the
  // response is no longer restricted to the first 20 credited participants.
  const request = await f.request(25);
  const today = await getLeaderboard(request, f.env, now);
  const before = await getLeaderboard(request, f.env, yesterday);
  assert.equal(today.date, shanghaiDay(now).date);
  assert.equal(before.date, shanghaiDay(yesterday).date);
  assert.equal(today.daily.length, 31);
  assert.equal(before.daily.length, 38);
  assert.equal(today.total.length, 58);
  assert.deepEqual(before.total, today.total);
  assert.ok(today.daily.every(entry => entry.points === 5 && entry.attempts === 1 && entry.rank === 1));
  assert.deepEqual(before.daily.map(entry => entry.rank), [...Array(27).fill(1), ...Array(11).fill(28)]);
  assert.deepEqual(today.total.map(entry => entry.rank), [...Array(11).fill(1), ...Array(27).fill(12), ...Array(20).fill(39)]);
  assert.deepEqual(today.mine?.daily, { rank: 1, points: 5, attempts: 1 });
  assert.deepEqual(today.mine?.total, { rank: 39, points: 5, attempts: 1 });
  assert.deepEqual(before.mine?.daily, { rank: null, points: 0, attempts: 0 });
  assert.ok(!today.total.some(entry => entry.name === f.name(58)));
});

test("the full public API keeps only public fields and sanitizes names after the former cutoff", async t => {
  const f = await fixture(t, 32);
  const current = new Date();
  for (let index = 0; index < 32; index++) f.points(index, 1, current);
  for (const database of [f.app, f.identity]) {
    database.sql.prepare("UPDATE users SET name=? WHERE id=?").run("private-visible-email@example.test", f.id(25));
    database.sql.prepare("UPDATE users SET name=? WHERE id=?").run("\u0000\u0007 同学030 \u007f", f.id(29));
  }
  f.permanentVip(31);
  const response = await worker.fetch(await f.request(), f.env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const result = await response.json() as LeaderboardData;
  assert.equal(result.mine, null);
  for (const board of [result.daily, result.total]) {
    assert.equal(board.length, 32);
    assert.equal(board[25].name, "练习同学");
    assert.equal(board[29].name, "同学030");
    assert.equal(board[31].isVip, true);
    assert.ok(board.every(entry => !entry.isMe));
    for (const entry of board) assert.deepEqual(Object.keys(entry).sort(), ["attempts", "isMe", "isVip", "name", "points", "rank"]);
  }
  const body = JSON.stringify(result);
  for (const privateValue of ["private-account-", "private-email-", "private-visible-email", "@example.test", "synthetic-private-password", "private-review-", "Private answer", "Private question", "PRIVATE-REFERRAL", "user_id", "expires_at", "referral_code", "token_hash", "fingerprint"]) {
    assert.ok(!body.includes(privateValue), `Public leaderboard exposed ${privateValue}`);
  }
});
