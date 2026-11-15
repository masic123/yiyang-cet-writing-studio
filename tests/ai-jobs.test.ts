import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createAiJobs, type AiJobConfiguration } from "../server/ai-jobs";
import { HttpError } from "../src/lib/http";

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(condition: () => boolean, message = "condition did not become true") {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (condition()) return;
    await sleep(2);
  }
  assert.fail(message);
}
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "ai-jobs-test-"));
  const path = join(root, "queue.sqlite");
  const controllers: ReturnType<typeof createAiJobs>[] = [];
  const make = (site: string, extra: Partial<AiJobConfiguration> = {}) => {
    const controller = createAiJobs({ path, site, recoverReviews: async () => [], executeReview: async () => {}, failReview: async () => {}, ...extra });
    controllers.push(controller);
    return controller;
  };
  t.after(async () => {
    await Promise.all(controllers.map(controller => controller.stop()));
    assert.ok(resolve(root).startsWith(resolve(join(tmpdir(), "ai-jobs-test-"))));
    rmSync(root, { recursive: true, force: true });
  });
  return { path, make };
}

test("two independent site connections share exactly twelve execution slots and retain FIFO", async t => {
  const f = fixture(t);
  const release = deferred();
  let running = 0, peak = 0;
  const order: string[] = [];
  const executeReview: AiJobConfiguration["executeReview"] = async (_, id, signal, owned) => {
    running++; peak = Math.max(peak, running); order.push(id);
    await release.promise;
    assert.equal(signal.aborted, false); assert.equal(owned(), true);
    running--;
  };
  const a = f.make("cet", { executeReview });
  const b = f.make("ielts", { executeReview });
  for (let i = 0; i < 26; i++) await (i % 2 ? b : a).jobs.enqueueReview("owner" + i, "review" + i);
  for (let i = 0; i < 26; i++) { await a.tick(); await b.tick(); }
  assert.equal(a.jobs.policy.concurrency, 12);
  assert.equal(a.snapshot().running, 12);
  assert.equal(b.snapshot().running, 12);
  assert.equal(a.snapshot().queued, 14);
  assert.deepEqual(order, Array.from({ length: 12 }, (_, i) => "review" + i));
  assert.equal(peak, 12);
  release.resolve();
  await until(() => a.snapshot().running === 0);
  for (let i = 0; i < 26; i++) { await a.tick(); await b.tick(); }
  await until(() => a.snapshot().completed === 26);
  assert.deepEqual(order, Array.from({ length: 26 }, (_, i) => "review" + i));
  assert.equal(peak, 12);
});

test("duplicate submissions enqueue once and a full queue creates a recoverable rejection tombstone", async t => {
  const f = fixture(t);
  const rejected: string[] = [];
  const a = f.make("cet", { options: { maxQueued: 2 }, failReview: async (_, id) => { rejected.push(id); } });
  const first = await a.jobs.enqueueReview("owner", "first");
  assert.deepEqual(await a.jobs.enqueueReview("owner", "first"), first);
  await a.jobs.enqueueReview("other", "second");
  await assert.rejects(a.jobs.enqueueReview("third", "third"), error => error instanceof HttpError && error.status === 429 && (error as HttpError & { retryAfterSeconds: number }).retryAfterSeconds === 5);
  assert.equal(a.snapshot().queued, 2);
  assert.equal(a.jobs.isManaged("third"), true);
  assert.equal(a.jobs.reviewInfo("third"), undefined);
  await a.tick();
  assert.deepEqual(rejected, ["third"]);
  assert.equal(a.snapshot().failed, 1);
});

test("interactive AI shares global capacity and cannot jump ahead of waiting reviews", async t => {
  const f = fixture(t);
  const gate = deferred();
  const options = { maxConcurrent: 1 };
  const a = f.make("cet", { options });
  const b = f.make("ielts", { options });
  const interactive = a.jobs.runInteractive("teacher", async signal => { assert.equal(signal.aborted, false); await gate.promise; return "done"; });
  await assert.rejects(b.jobs.runInteractive("other", async () => "unexpected"), error => error instanceof HttpError && error.status === 429);
  await b.jobs.enqueueReview("writer", "waiting");
  gate.resolve(); assert.equal(await interactive, "done");
  await assert.rejects(a.jobs.runInteractive("teacher", async () => "unexpected"), error => error instanceof HttpError && error.status === 429);
  await b.tick();
  await until(() => b.snapshot().completed === 2);
});

test("provider overload retries once with backoff and terminal jobs never replay", async t => {
  const f = fixture(t);
  let clock = 10_000, calls = 0;
  const failures: string[] = [];
  const a = f.make("cet", {
    options: { now: () => clock, retryBaseMs: 5 },
    recoverReviews: async () => [{ owner: "owner", id: "retry", createdAt: new Date(10_000).toISOString() }],
    executeReview: async () => { calls++; throw new HttpError(503, "temporary overload", "PROVIDER_BUSY"); },
    failReview: async (_, id) => { failures.push(id); },
  });
  await a.tick(); await until(() => a.snapshot().retrying === 1);
  await a.tick(); assert.equal(calls, 1);
  clock += 5; await a.tick(); await until(() => a.snapshot().failed === 1);
  await a.tick(); assert.deepEqual(failures, ["retry"]);
  clock += 6_000; await a.tick(); assert.equal(calls, 2);
  assert.equal(a.jobs.isManaged("retry"), true);
});

test("invalid reports and authentication failures fail without an automatic retry", async t => {
  const f = fixture(t);
  let calls = 0;
  const failed: string[] = [];
  const a = f.make("cet", {
    executeReview: async (_, id) => { calls++; throw new HttpError(502, "invalid report", id === "auth" ? "PROVIDER_ERROR" : "INVALID_FEEDBACK"); },
    failReview: async (_, id) => { failed.push(id); },
  });
  await a.jobs.enqueueReview("one", "auth"); await a.jobs.enqueueReview("two", "invalid");
  await a.tick(); await until(() => a.snapshot().failed === 2); await a.tick();
  assert.equal(calls, 2); assert.deepEqual(failed, ["auth", "invalid"]);
});

test("a crashed lease is fenced, recovered once, and the old owner cannot complete the new attempt", async t => {
  const f = fixture(t);
  let clock = 30_000;
  const options = { now: () => clock, leaseMs: 30_000, retryBaseMs: 1 };
  const original = deferred();
  let oldOwned!: () => boolean;
  let oldSignal!: AbortSignal;
  const first = f.make("cet", { options, executeReview: async (_, __, signal, owned) => { oldSignal = signal; oldOwned = owned; await original.promise; } });
  const recovered = f.make("cet", { options });
  await first.jobs.enqueueReview("owner", "crashed"); await first.tick();
  assert.equal(oldOwned(), true);
  clock += 30_001;
  await recovered.tick();
  assert.equal(oldOwned(), false);
  clock++;
  await recovered.tick(); await until(() => recovered.snapshot().completed === 1);
  original.resolve();
  await until(() => first.snapshot().running === 0);
  // The expired callback's return cannot replace the completed second claim.
  assert.equal(first.snapshot().completed, 1);
  await first.tick(); assert.equal(oldSignal.aborted, true);
});

test("orphan review recovery preserves original queue age and retries failed completion bookkeeping", async t => {
  const f = fixture(t);
  let attempts = 0, executed = 0;
  const a = f.make("cet", {
    options: { now: () => 100_000, maxQueueMs: 1000 },
    recoverReviews: async () => [{ owner: "owner", id: "old", createdAt: new Date(1).toISOString() }],
    executeReview: async () => { executed++; },
    failReview: async () => { if (++attempts === 1) throw new Error("temporary site DB failure"); },
  });
  await a.tick(); assert.equal(attempts, 1); assert.equal(executed, 0);
  await a.tick(); assert.equal(attempts, 2); assert.equal(a.snapshot().failed, 1);
});

test("queue survives a graceful restart without duplicating a completed review", async t => {
  const f = fixture(t);
  let calls = 0;
  const first = f.make("cet");
  await first.jobs.enqueueReview("owner", "persisted");
  await first.stop();
  const next = f.make("cet", {
    executeReview: async () => { calls++; },
    recoverReviews: async () => [{ owner: "owner", id: "persisted" }],
  });
  await next.tick(); await until(() => next.snapshot().completed === 1);
  await next.tick(); assert.equal(calls, 1);
});

test("execution timeout aborts work and bounded retries end in a durable failed result", async t => {
  const f = fixture(t);
  let calls = 0, aborted = 0;
  const a = f.make("cet", {
    options: { maxRunMs: 20, leaseMs: 30, retryBaseMs: 1, pollMs: 1 },
    executeReview: async (_, __, signal) => {
      calls++;
      await new Promise<void>((_, reject) => signal.addEventListener("abort", () => { aborted++; reject(signal.reason); }, { once: true }));
    },
  });
  await a.jobs.enqueueReview("owner", "timeout"); a.start();
  await until(() => a.snapshot().failed === 1);
  assert.equal(calls, 2); assert.equal(aborted, 2);
});

test("interactive cancellation releases its slot and shared policy drift is rejected", async t => {
  const f = fixture(t);
  const a = f.make("cet");
  const controller = new AbortController();
  const request = a.jobs.runInteractive("owner", signal => new Promise<void>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }), controller.signal);
  await sleep(1); controller.abort(new Error("client left"));
  await assert.rejects(request, /client left/);
  assert.equal(a.snapshot().running, 0);
  assert.throws(() => createAiJobs({ path: f.path, site: "ielts", options: { maxConcurrent: 4 }, executeReview: async () => {}, failReview: async () => {}, recoverReviews: async () => [] }), /policy differs/);
  const inspection = new DatabaseSync(f.path, { readOnly: true });
  try {
    assert.deepEqual(inspection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").all(), []);
    assert.equal(inspection.prepare("SELECT COUNT(*) AS n FROM ai_jobs").get()!.n, 1);
  } finally { inspection.close(); }
});

test("an offline site's oldest job does not block a live site and resumes when its worker returns", async t => {
  const f = fixture(t);
  const order: string[] = [];
  const offline = f.make("ielts");
  await offline.jobs.enqueueReview("one", "offline-first");
  await offline.stop();
  const live = f.make("cet", { executeReview: async (_, id) => { order.push(id); } });
  await live.jobs.enqueueReview("two", "live-second");
  await live.tick(); await until(() => live.snapshot().completed === 1);
  assert.deepEqual(order, ["live-second"]);
  assert.equal(live.snapshot().queued, 1);
  const returned = f.make("ielts", { executeReview: async (_, id) => { order.push(id); } });
  await returned.tick(); await until(() => returned.snapshot().completed === 2);
  assert.deepEqual(order, ["live-second", "offline-first"]);
});

test("an operation ignoring abort retains a physical slot until it actually settles", async t => {
  const f = fixture(t);
  const gate = deferred();
  const a = f.make("cet", { options: { maxConcurrent: 1, maxRunMs: 20, leaseMs: 60 } });
  const first = a.jobs.runInteractive("slow", async () => { await gate.promise; });
  await assert.rejects(first, error => error instanceof HttpError && error.code === "AI_JOB_TIMEOUT");
  assert.equal(a.snapshot().running, 1);
  await assert.rejects(a.jobs.runInteractive("second", async () => "would exceed capacity"), error => error instanceof HttpError && error.status === 429);
  gate.resolve();
  await until(() => a.snapshot().running === 0);
  assert.equal(await a.jobs.runInteractive("next", async () => "ok"), "ok");
});

test("an interactive result arriving after lease expiry is rejected even before the heartbeat aborts", async t => {
  const f = fixture(t);
  let clock = 1000;
  const gate = deferred();
  const a = f.make("cet", { options: { now: () => clock, leaseMs: 30_000 } });
  const result = a.jobs.runInteractive("owner", async () => { await gate.promise; return "late result"; });
  clock += 30_001; gate.resolve();
  await assert.rejects(result, error => error instanceof HttpError && error.code === "AI_JOB_CANCELLED");
  assert.equal(a.snapshot().completed, 0);
});

test("a provider Retry-After delays the only automatic retry", async t => {
  const f = fixture(t);
  let clock = 10_000, calls = 0;
  const a = f.make("cet", {
    options: { now: () => clock, retryBaseMs: 1 },
    executeReview: async () => { calls++; throw new HttpError(503, "busy", "PROVIDER_BUSY", 5); },
  });
  await a.jobs.enqueueReview("owner", "delayed"); await a.tick(); await until(() => a.snapshot().retrying === 1);
  clock += 4999; await a.tick(); assert.equal(calls, 1);
  clock++; await a.tick(); await until(() => a.snapshot().failed === 1); assert.equal(calls, 2);
});

test("the scheduler rejects an application/account database before modifying its schema", async t => {
  const f = fixture(t);
  const inspection = new DatabaseSync(f.path);
  inspection.exec("CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES('synthetic');");
  assert.throws(() => createAiJobs({ path: f.path, site: "cet", executeReview: async () => {}, failReview: async () => {}, recoverReviews: async () => [] }), /own database/);
  assert.equal(inspection.prepare("SELECT COUNT(*) AS n FROM users").get()!.n, 1);
  assert.deepEqual(inspection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'ai_%'").all(), []);
  inspection.close();
});

test("a running provider failure cannot add a thirty-first waiting task when retry capacity is full", async t => {
  const f = fixture(t);
  const fail = deferred(), release = deferred();
  const messages: string[] = [];
  const a = f.make("cet", {
    options: { maxConcurrent: 3 },
    executeReview: async (_, id) => { if (id === "running0") { await fail.promise; throw new HttpError(503, "busy", "PROVIDER_BUSY"); } await release.promise; },
    failReview: async (_, __, message) => { messages.push(message); },
  });
  try {
    for (let i = 0; i < 3; i++) await a.jobs.enqueueReview("owner" + i, "running" + i);
    await a.tick(); assert.equal(a.snapshot().running, 3);
    for (let i = 0; i < 30; i++) await a.jobs.enqueueReview("waiting" + i, "waiting" + i);
    fail.resolve(); await until(() => a.snapshot().failed === 1);
    assert.equal(a.snapshot().queued + a.snapshot().retrying, 30);
    await a.tick(); assert.ok(messages[0].includes("本次未自动重试"));
  } finally { release.resolve(); fail.resolve(); }
});

test("expired leases cannot add retries beyond the thirty waiting-task capacity", async t => {
  const f = fixture(t); let clock = 10_000;
  const release = deferred();
  const a = f.make("cet", { options: { now: () => clock, maxConcurrent: 3 }, executeReview: async () => { await release.promise; } });
  try {
    for (let i = 0; i < 3; i++) await a.jobs.enqueueReview("owner" + i, "running" + i);
    await a.tick();
    for (let i = 0; i < 30; i++) await a.jobs.enqueueReview("waiting" + i, "waiting" + i);
    clock += 30_001;
    await a.tick();
    // Three next reviews can start, but the three expired ones must fail rather than joining a full queue.
    assert.equal(a.snapshot().failed, 3);
    assert.ok(a.snapshot().queued + a.snapshot().retrying <= 30);
  } finally { release.resolve(); }
});
