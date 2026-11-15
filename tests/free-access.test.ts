import { test } from "node:test";
import assert from "node:assert/strict";
import type { D1Database } from "@cloudflare/workers-types";
import { sqliteDatabase } from "../server/database";
import worker from "../worker/index";
import {
  activeMembershipIds, createMembershipCards, finishMembershipReview,
  freeAccessEnabled, membershipAccessEnabled, membershipEnabled,
  membershipReviewMode, membershipStatus, reconcileEarlyMemberGifts,
  reconcileMembershipUsage, redeemMembership, registrationMembershipStatements,
  reserveMembershipReview,
} from "../worker/membership";
import { beginReview, finishReview } from "../worker/repository";
import { questions } from "../src/lib/content";
import type { EssayInput, Feedback } from "../src/lib/types";
import type { Env } from "../worker/types";

const origin = "https://free.example.test";
const key = () => crypto.randomUUID();
const unavailableDatabase = {
  prepare() { throw new Error("Free access must not query or mutate membership data"); },
  batch() { throw new Error("Free access must not initialize membership data"); },
} as unknown as D1Database;
const freeEnv = (db = unavailableDatabase): Env => ({
  DB: db, AUTH_DB: unavailableDatabase,
  ASSETS: { fetch: async () => new Response("asset") },
  FREE_ACCESS_ENABLED: "true", MEMBERSHIP_ENABLED: "true",
  MEMBERSHIP_REQUIRE_READY: "true", MEMBERSHIP_LAUNCH_AT: "invalid legacy value",
  MEMBERSHIP_LAUNCH_DEFERRED: "true", DAILY_REVIEW_LIMIT: "1",
});

test("free access overrides every legacy membership switch without reading the identity database", async () => {
  const env = freeEnv();
  assert.equal(freeAccessEnabled(env), true);
  assert.equal(membershipEnabled(env), false);
  assert.equal(await membershipAccessEnabled(env), false);
  assert.equal(await membershipReviewMode(env, "learner"), "free");
  const state = await membershipStatus(env, "learner");
  assert.equal(state.freeAccess, true);
  assert.equal(state.enabled, false);
  assert.equal(state.accessEnabled, false);
  assert.deepEqual(state.plans, []);
  assert.equal(state.account, null);
  const response = await worker.fetch(new Request(origin + "/api/membership"), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), state);
});

test("free membership registration and review accounting never create or update membership tables", async () => {
  const env = freeEnv();
  assert.deepEqual(await registrationMembershipStatements(env, "learner", "OLD-INVITE"), []);
  assert.deepEqual([...await activeMembershipIds(env, ["learner"])], []);
  await reserveMembershipReview(env, "learner", key(), key());
  await finishMembershipReview(env, "learner", key(), true);
  await reconcileMembershipUsage(env, "learner");
  await reconcileEarlyMemberGifts(env);
});

test("old purchase, redemption, issuance and promotion URLs cannot revive membership sales", async () => {
  const env = freeEnv();
  await assert.rejects(createMembershipCards(env, "admin", 1, "old card"), /免费开放/);
  await assert.rejects(redeemMembership(env, "learner", "YY-" + "A".repeat(32)), /免费开放/);
  for (const [path, method] of [
    ["/api/membership/redeem", "POST"],
    ["/api/membership/cards", "POST"],
    ["/api/membership/promotion-checkout?plan=week", "GET"],
    ["/api/membership/promotion-share", "GET"],
    ["/api/membership/promotions", "GET"],
  ]) {
    const response = await worker.fetch(new Request(origin + path, { method }), env);
    assert.equal(response.status, 410, path);
    assert.equal((await response.json()).code, "FREE_ACCESS_ENABLED");
    assert.equal(response.headers.get("Location"), null);
  }
});

test("real reviews exceed both former quotas while idempotency and in-flight protection remain", async t => {
  const local = sqliteDatabase(":memory:");
  t.after(() => local.sql.close());
  local.sql.prepare("INSERT INTO users(id,name,email,password,created_at) VALUES('learner','Learner','learner@example.test','!test',?)").run(new Date().toISOString());
  const env = { ...freeEnv(local.db), AUTH_DB: local.db };
  const question = questions().find(q => ["writing", "Task 2"].includes(q.task))!;
  const input = { questionId: question.id, essay: "An original synthetic answer for the free review repository fixture.", targetBand: 7, targetScore: 11, title: "Free review" } as EssayInput;
  const feedback = { overallBand: 6, holisticScore: 11, assessmentScope: "full" } as unknown as Feedback;
  const requestKey = key();
  const first = await beginReview(env, "learner", input, requestKey, "test");
  assert.equal(first.created, true);
  assert.equal((await beginReview(env, "learner", input, requestKey, "test")).created, false);
  await assert.rejects(beginReview(env, "learner", input, key(), "test"), /正在批改/);
  await finishReview(env, "learner", first.review.id, feedback);
  for (let i = 0; i < 17; i++) {
    const next = await beginReview(env, "learner", { ...input, essay: input.essay + " " + i }, key(), "test");
    await finishReview(env, "learner", next.review.id, feedback);
  }
  assert.equal(local.sql.prepare("SELECT COUNT(*) AS n FROM reviews WHERE user_id='learner' AND status='completed'").get()!.n, 18);
  assert.equal(local.sql.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE 'membership_%'").get()!.n, 0);
});

test("free access keeps login required for saved reviews and AI teacher", async t => {
  const local = sqliteDatabase(":memory:");
  t.after(() => local.sql.close());
  const env = { ...freeEnv(local.db), AUTH_DB: local.db };
  for (const path of ["/api/reviews", "/api/teacher"]) {
    const response = await worker.fetch(new Request(origin + path, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: "{}" }), env);
    assert.equal(response.status, 401, path);
  }
});
