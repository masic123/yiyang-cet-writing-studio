import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteDatabase } from "../server/database";
import { createReviewJobs } from "../server/review-jobs";
import { abortableFetch, fencedDatabase } from "../worker/ai-capacity";
import { beginReview, expireReviews, getReview, listReviews } from "../worker/repository";
import { createSession } from "../worker/auth";
import worker from "../worker/index";
import { questions, resolveQuestion } from "../src/lib/content";
import { assessEssay } from "../src/lib/reviewer";
import { HttpError } from "../src/lib/http";
import type { AiJobs, ReviewQueueInfo } from "../src/lib/ai-jobs";
import type { Env } from "../worker/types";
import type { EssayInput, Feedback } from "../src/lib/types";

const origin = "https://queue.example.test";
const key = () => crypto.randomUUID();
const essay = "Students can improve their writing by practising every day and carefully reviewing their previous work. Teachers should explain the reasons for each correction and encourage students to develop their own ideas with clear examples and accurate language.";
const input = (): EssayInput => ({ questionId: questions().find(q => ["writing", "Task 2"].includes(q.task))!.id, essay, title: "Synthetic queue review", targetBand: 7, targetScore: 11 } as EssayInput);
const queued: ReviewQueueInfo = { state: "queued", position: 1, attempt: 0 };
function fakeJobs(patch: Partial<AiJobs> = {}): AiJobs {
  return {
    policy: { concurrency: 3, maxPending: 30, maxWaitMs: 900000, runTimeoutMs: 240000 },
    enqueueReview: async () => queued,
    reviewInfo: () => queued,
    isManaged: () => true,
    runInteractive: async (_owner, action, signal) => action(signal ?? new AbortController().signal, () => true),
    ...patch,
  };
}
async function fixture(t: { after(fn: () => void | Promise<void>): void }) {
  const local = sqliteDatabase(":memory:");
  const env: Env = { DB: local.db, ASSETS: { fetch: async () => new Response("asset") }, FREE_ACCESS_ENABLED: "true", MEMBERSHIP_ENABLED: "false", DEEPSEEK_API_KEY: "synthetic-not-a-real-key" };
  t.after(() => local.sql.close());
  for (const id of ["learner", "other"]) local.sql.prepare("INSERT INTO users(id,email,name,password,created_at) VALUES(?,?,?,?,?)").run(id, id + "@example.test", id, "!synthetic", new Date().toISOString());
  const cookies = new Map<string, string>();
  for (const owner of ["learner", "other"]) cookies.set(owner, (await createSession(new Request(origin), env, owner)).split(";")[0]);
  const request = (path: string, body?: unknown, owner = "learner") => worker.fetch(new Request(origin + path, { method: body ? "POST" : "GET", headers: { Cookie: cookies.get(owner)!, Origin: origin, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }), env);
  return { ...local, env, request };
}
const providerFeedback = {
  assessmentScope: "full", overallBand: 6.5, holisticScore: 11, summary: "Synthetic queue completion", corrections: [], priorities: [], methodChecks: [], paragraphs: [], advancedSuggestions: [], notebookHighlights: [], exercises: [],
  criteria: { taskResponse: { score: 6.5 }, coherence: { score: 6.5 }, lexical: { score: 6.5 }, grammar: { score: 6.5 } },
} as unknown as Feedback;
async function until(action: () => boolean | Promise<boolean>) {
  const end = Date.now() + 3000;
  while (!await action()) { if (Date.now() > end) throw new Error("Synthetic queue did not settle"); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test("review admission returns 202 immediately and repeat request keys address one durable review", async t => {
  const f = await fixture(t);
  const admitted = new Set<string>();
  f.env.AI_JOBS = fakeJobs({ enqueueReview: async (owner, id) => { assert.equal(owner, "learner"); admitted.add(id); return queued; } });
  const body = { input: input(), requestKey: key() };
  const first = await f.request("/api/reviews", body);
  assert.equal(first.status, 202);
  assert.equal(first.headers.get("Cache-Control"), "no-store");
  const saved = (await first.json()).review;
  assert.equal(saved.status, "processing"); assert.deepEqual(saved.queue, queued);
  const retry = await f.request("/api/reviews", body);
  assert.equal(retry.status, 202); assert.equal((await retry.json()).review.id, saved.id);
  assert.equal(admitted.size, 1);
  assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM reviews").get()!.n, 1);
  const publicConfig = await (await f.request("/api/config")).json();
  assert.deepEqual(publicConfig.aiQueue, { enabled: true, concurrency: 3, maxPending: 30 });
});

test("queue overload returns Retry-After, preserves the answer and releases the account for a later retry", async t => {
  const f = await fixture(t);
  f.env.AI_JOBS = fakeJobs({ enqueueReview: async () => { throw new HttpError(429, "批改任务较多，作答已保留。", "AI_QUEUE_FULL", 5); }, reviewInfo: () => undefined });
  const response = await f.request("/api/reviews", { input: input(), requestKey: key() });
  assert.equal(response.status, 429); assert.equal(response.headers.get("Retry-After"), "5");
  assert.equal((await response.json()).code, "AI_QUEUE_FULL");
  const stored = f.sql.prepare("SELECT status,input FROM reviews").get()!;
  assert.equal(stored.status, "failed"); assert.equal(JSON.parse(String(stored.input)).essay, essay);
  f.env.AI_JOBS = fakeJobs();
  assert.equal((await f.request("/api/reviews", { input: input(), requestKey: key() })).status, 202);
});

test("managed waiting reviews survive legacy expiration and stay private to their owner", async t => {
  const f = await fixture(t);
  const started = await beginReview(f.env, "learner", input(), key(), "synthetic");
  f.sql.prepare("UPDATE reviews SET created_at=? WHERE id=?").run(new Date(Date.now() - 12 * 60000).toISOString(), started.review.id);
  f.env.AI_JOBS = fakeJobs();
  await expireReviews(f.env, "learner");
  assert.equal((await listReviews(f.env, "learner"))[0].status, "processing");
  assert.deepEqual((await getReview(f.env, "learner", started.review.id)).queue, queued);
  const denied = await f.request("/api/reviews?id=" + started.review.id, undefined, "other");
  assert.equal(denied.status, 404);
  f.env.AI_JOBS = fakeJobs({ isManaged: () => false, reviewInfo: () => undefined });
  await expireReviews(f.env, "learner");
  assert.equal((await getReview(f.env, "learner", started.review.id)).status, "failed");
});

test("AI teacher uses the same capacity gate and returns bounded overload feedback", async t => {
  const f = await fixture(t); let gates = 0;
  f.env.AI_JOBS = fakeJobs({ runInteractive: async owner => { assert.equal(owner, "learner"); gates++; throw new HttpError(429, "当前任务较多，请稍后再试。", "AI_QUEUE_FULL", 5); } });
  const result = await f.request("/api/teacher", { messages: [{ role: "user", content: "How can I improve my introduction?" }] });
  assert.equal(result.status, 429); assert.equal(result.headers.get("Retry-After"), "5"); assert.equal(gates, 1);
});

test("a revoked worker cannot issue another provider call or overwrite a stored draft", async t => {
  const f = await fixture(t); let owned = true; let requests = 0;
  const signal = new AbortController();
  const requestFetch = abortableFetch(signal.signal, () => owned, (async (_input, init) => { requests++; assert.ok(init?.signal); return new Response("synthetic"); }) as typeof fetch);
  await requestFetch("https://provider.example.test");
  const protectedDB = fencedDatabase(f.db, () => owned);
  const statement = protectedDB.prepare("UPDATE users SET name='overwritten' WHERE id='learner'");
  owned = false;
  assert.throws(() => requestFetch("https://provider.example.test"), error => error instanceof HttpError && error.code === "AI_JOB_CANCELLED");
  assert.throws(() => statement.run(), error => error instanceof HttpError && error.code === "AI_JOB_CANCELLED");
  assert.equal(requests, 1); assert.equal(f.sql.prepare("SELECT name FROM users WHERE id='learner'").get()!.name, "learner");
});

test("real scheduler persists a review across restart and commits one completed result", async t => {
  const f = await fixture(t); const directory = mkdtempSync(join(tmpdir(), "writing-queue-integration-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "jobs.sqlite"); let calls = 0;
  const options = { path, site: "fixture", scheduler: { maxConcurrent: 1, maxQueued: 4, maxQueueMs: 60000, maxRunMs: 1000, pollMs: 10, leaseMs: 300, recoverMs: 20, retryBaseMs: 10 }, assess: async () => { calls++; return providerFeedback; } };
  const first = createReviewJobs(f.env, options);
  const result = await f.request("/api/reviews", { input: input(), requestKey: key() });
  assert.equal(result.status, 202); const id = (await result.json()).review.id;
  await first.stop();
  const second = createReviewJobs(f.env, options); second.start();
  try {
    await until(async () => (await getReview(f.env, "learner", id)).status === "completed");
    assert.equal(calls, 1); assert.equal((await getReview(f.env, "learner", id)).queue, undefined);
    assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM leaderboard_receipts WHERE review_id=?").get(id)!.n, 1);
  } finally { await second.stop(); }
});

test("runtime repairs the cross-database admission gap and bounds transient retries", async t => {
  const f = await fixture(t); const directory = mkdtempSync(join(tmpdir(), "writing-queue-recovery-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const started = await beginReview(f.env, "learner", input(), key(), "synthetic");
  f.sql.prepare("UPDATE reviews SET created_at=? WHERE id=?").run(new Date(Date.now() - 10000).toISOString(), started.review.id);
  let calls = 0;
  const runtime = createReviewJobs(f.env, { path: join(directory, "jobs.sqlite"), site: "fixture", scheduler: { maxConcurrent: 1, maxQueued: 4, maxQueueMs: 60000, maxRunMs: 1000, pollMs: 10, leaseMs: 300, recoverMs: 20, retryBaseMs: 10 }, assess: async () => { calls++; if (calls === 1) throw new HttpError(503, "Synthetic upstream busy", "PROVIDER_BUSY"); return providerFeedback; } });
  runtime.start();
  try {
    await until(async () => (await getReview(f.env, "learner", started.review.id)).status === "completed");
    assert.equal(calls, 2);
    assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM leaderboard_receipts WHERE review_id=?").get(started.review.id)!.n, 1);
  } finally { await runtime.stop(); }
});

test("invalid scoring results fail once and never enter an automatic retry loop", async t => {
  const f = await fixture(t); const directory = mkdtempSync(join(tmpdir(), "writing-queue-permanent-"));
  t.after(() => rmSync(directory, { recursive: true, force: true })); let calls = 0;
  const runtime = createReviewJobs(f.env, { path: join(directory, "jobs.sqlite"), site: "fixture", scheduler: { maxConcurrent: 1, maxQueued: 4, maxQueueMs: 60000, maxRunMs: 1000, pollMs: 10, leaseMs: 300, recoverMs: 20, retryBaseMs: 10 }, assess: async () => { calls++; throw new HttpError(502, "Synthetic invalid result", "INVALID_FEEDBACK"); } });
  runtime.start();
  try {
    const response = await f.request("/api/reviews", { input: input(), requestKey: key() }); assert.equal(response.status, 202);
    const id = (await response.json()).review.id;
    await until(async () => (await getReview(f.env, "learner", id)).status === "failed");
    assert.equal(calls, 1); assert.equal((await getReview(f.env, "learner", id)).input.essay, essay);
  } finally { await runtime.stop(); }
});


test("late notebook generation and checking results cannot be committed after their shared lease is revoked", async t => {
  const f = await fixture(t); let owned = true;
  const itemId = key();
  const detail = { title: "情态动词后用原形", kind: "grammar", wrong: "can helps", right: "can help", pattern: "modal + base verb", explanation: "情态动词后用动词原形。" };
  f.sql.prepare("INSERT INTO notebook_items(id,user_id,signature,detail,updated_at) VALUES(?,?,?,?,?)").run(itemId, "learner", "synthetic-modal", JSON.stringify(detail), new Date().toISOString());
  f.env.AI_JOBS = fakeJobs({ runInteractive: async (_owner, action) => action(new AbortController().signal, () => owned) });
  const generated = { title: "合成练习", instruction: "翻译下列句子。", prompt: "图书馆可以帮助学生。", referenceAnswer: "The library can help students.", coverage: [{ itemId, expression: "can help", explanation: "练习动词原形。" }] };
  let payload: unknown = generated;
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = (async () => {
    // The provider finished, but a newer worker owns the slot before parsing and saving.
    owned = false;
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(payload) } }] });
  }) as typeof fetch;
  const generation = await f.request("/api/notebook/exercises", { requestKey: key(), itemIds: [itemId], task: "translation", examType: "CET4" });
  assert.equal(generation.status, 503); assert.equal((await generation.json()).code, "AI_JOB_CANCELLED");
  const generatedRow = f.sql.prepare("SELECT status,content FROM notebook_exercises").get()!;
  assert.equal(generatedRow.status, "failed"); assert.equal(generatedRow.content, null);
  const exerciseId = key();
  f.sql.prepare("INSERT INTO notebook_exercises(id,user_id,request_key,task,exam_type,status,targets,content,model,created_at) VALUES(?,?,?,'translation','CET4','completed',?,?,'synthetic',?)")
    .run(exerciseId, "learner", key(), JSON.stringify([{ id: itemId, ...detail }]), JSON.stringify(generated), new Date().toISOString());
  payload = { summary: "合成检查结果", revisedAnswer: "The library can help students.", results: [{ itemId, status: "secure", quote: "can help", correction: "", explanation: "本句使用动词原形。" }] };
  owned = true;
  const checking = await f.request("/api/notebook/attempts", { requestKey: key(), exerciseId, answer: "The library can help students." });
  assert.equal(checking.status, 503); assert.equal((await checking.json()).code, "AI_JOB_CANCELLED");
  const attempt = f.sql.prepare("SELECT status,feedback,answer FROM notebook_attempts").get()!;
  assert.equal(attempt.status, "failed"); assert.equal(attempt.feedback, null); assert.equal(attempt.answer, "The library can help students.");
});


test("upstream congestion is retryable while credentials and balance failures remain permanent", async () => {
  for (const status of [429, 503, 401, 402]) {
    let calls = 0;
    const provider = (async () => { calls++; return Response.json({ error: "synthetic" }, { status, headers: { "Retry-After": "7" } }); }) as typeof fetch;
    const value = input();
    await assert.rejects(assessEssay(value, resolveQuestion(value), { DEEPSEEK_API_KEY: "synthetic-not-a-real-key" }, { fetch: async () => new Response("asset") }, provider), error => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, status === 429 || status >= 500 ? 503 : 502);
      assert.equal(error.code, status === 429 || status >= 500 ? "PROVIDER_BUSY" : "PROVIDER_ERROR");
      if (error.code === "PROVIDER_BUSY") assert.equal(error.retryAfterSeconds, 7);
      return true;
    });
    assert.equal(calls, 1);
  }
});
