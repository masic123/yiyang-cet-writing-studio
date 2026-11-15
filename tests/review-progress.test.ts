import { test } from "node:test";
import assert from "node:assert/strict";
import { createReviewViewState, pollReview, reviewProgress } from "../src/lib/review-progress";

const flush = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };

test("a slow status request cannot create overlapping polls or update a stopped view", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0, received = 0, resolve!: (value: { status: string }) => void;
  let signal!: AbortSignal;
  const stop = pollReview({
    read: async (value) => { calls++; signal = value; return new Promise<{ status: string }>((yes) => { resolve = yes; }); },
    receive: () => { received++; }, problem: () => {},
  });
  t.mock.timers.tick(250); await flush();
  t.mock.timers.tick(8000); await flush();
  assert.equal(calls, 1);
  stop(); assert.equal(signal.aborted, true);
  resolve({ status: "completed" }); await flush();
  t.mock.timers.tick(60000); await flush();
  assert.equal(calls, 1); assert.equal(received, 0);
});

test("network failures back off, successful completion clears the notice and ends polling", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const statuses: string[] = [], notices: string[] = [];
  const stop = pollReview({
    read: async () => { calls++; if (calls === 1) throw new Error("network"); return { status: "completed" }; },
    receive: (value) => statuses.push(value.status), problem: (message) => notices.push(message),
  });
  t.mock.timers.tick(250); await flush();
  assert.match(notices[0], /批改仍在后台进行/);
  t.mock.timers.tick(7999); await flush(); assert.equal(calls, 1);
  t.mock.timers.tick(1); await flush(); assert.deepEqual(statuses, ["completed"]);
  assert.equal(notices.at(-1), "");
  t.mock.timers.tick(60000); await flush(); assert.equal(calls, 2); stop();
});

test("expired sessions stop status queries and hidden pages use a slower interval", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0, message = "";
  const stop = pollReview({
    read: async () => { calls++; if (calls === 2) throw Object.assign(new Error("login"), { status: 401 }); return { status: "processing" }; },
    receive: () => {}, problem: (value) => { message = value; }, visible: () => false,
  });
  t.mock.timers.tick(250); await flush();
  t.mock.timers.tick(14999); await flush(); assert.equal(calls, 1);
  t.mock.timers.tick(1); await flush(); assert.equal(calls, 2); assert.match(message, /重新登录/);
  t.mock.timers.tick(60000); await flush(); assert.equal(calls, 2); stop();
});

test("queue progress distinguishes waiting, retrying and active review without inventing wait times", () => {
  const base = { status: "processing" as const, queue: { state: "queued" as const, position: 5, attempt: 0 } };
  assert.match(reviewProgress(base).description, /第 5 位/);
  assert.equal(reviewProgress({ ...base, queue: { ...base.queue, state: "retrying" } }).label, "等待重试");
  assert.equal(reviewProgress({ ...base, queue: { ...base.queue, state: "running" } }).label, "正在批改");
  assert.equal(reviewProgress({ status: "completed" }).label, "已完成");
});


test("a delayed report A cannot replace a newer report B or revive a previous account", async () => {
  const view = createReviewViewState(); const scope = "learner:1";
  let shown = "initial";
  let resolveA!: (value: { id: string; status: string }) => void;
  const openA = view.beginOpen(scope, "A");
  const delayedA = new Promise<{ id: string; status: string }>(resolve => { resolveA = resolve; }).then(review => { if (view.accept(openA, review, scope)) shown = review.id; });
  const openB = view.beginOpen(scope, "B");
  assert.equal(view.accept(openB, { id: "B", status: "completed" }, scope), true); shown = "B";
  resolveA({ id: "A", status: "processing" }); await delayedA;
  assert.equal(shown, "B"); assert.equal(view.busy(scope), false);
  const oldB = view.capture(scope, "B")!;
  view.choose("other:2", { id: "B", status: "processing" });
  assert.equal(view.accept(oldB, { id: "B", status: "completed" }, "other:2"), false);
  assert.equal(view.busy("other:2"), true);
});

test("synchronous history selection rejects a previous poll before React effect cleanup", () => {
  const view = createReviewViewState(); const scope = "learner:1";
  view.choose(scope, { id: "A", status: "processing" });
  const pollA = view.capture(scope, "A")!;
  assert.equal(view.busy(scope), true);
  view.choose(scope, { id: "B", status: "completed" });
  assert.equal(view.busy(scope), false);
  assert.equal(view.accept(pollA, { id: "A", status: "processing" }, scope), false);
  view.block(pollA, scope);
  assert.equal(view.busy(scope), false);
  view.choose(scope, { id: "C", status: "failed" }); assert.equal(view.busy(scope), false);
});

test("choosing a terminal history report cannot unlock a still submitting request or force late navigation", async () => {
  const view = createReviewViewState(); const scope = "learner:1";
  const submission = view.beginSubmission(scope);
  let finish!: (value: { id: string; status: string }) => void;
  const delayed = new Promise<{ id: string; status: string }>(resolve => { finish = resolve; });
  view.choose(scope, { id: "history", status: "completed" });
  assert.equal(view.busy(scope), true);
  finish({ id: "new-review", status: "processing" });
  const shouldNavigate = view.finishSubmission(submission, await delayed, scope);
  assert.equal(shouldNavigate, false); assert.equal(view.busy(scope), false);
  assert.ok(view.capture(scope, "history")); assert.equal(view.capture(scope, "new-review"), undefined);
});

test("an older submission cannot release a new account's active submission", () => {
  const view = createReviewViewState();
  const old = view.beginSubmission("first:1");
  const current = view.beginSubmission("second:2");
  assert.equal(view.finishSubmission(old, { id: "old", status: "completed" }, "second:2"), false);
  assert.equal(view.busy("second:2"), true);
  assert.equal(view.finishSubmission(current, { id: "current", status: "processing" }, "second:2"), true);
  assert.equal(view.busy("second:2"), true);
  const token = view.capture("second:2", "current")!;
  assert.equal(view.accept(token, { id: "current", status: "completed" }, "second:2"), true);
  assert.equal(view.busy("second:2"), false);
});

test("permanent polling permission failures unlock editing without mutating or cancelling the background review", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const status of [401, 403, 404]) {
    const view = createReviewViewState(); const scope = "learner:1";
    const persisted = { id: "pending", status: "processing" };
    const token = view.choose(scope, persisted); let calls = 0, stoppedNotice = false;
    const stop = pollReview({
      read: async () => { calls++; throw Object.assign(new Error("Synthetic denied"), { status }); },
      receive: () => { throw new Error("A failed GET cannot replace the report"); },
      problem: (_message, stopped) => { stoppedNotice = !!stopped; if (stopped) view.block(token, scope); },
    });
    t.mock.timers.tick(250); await flush();
    assert.equal(stoppedNotice, true); assert.equal(view.busy(scope), false);
    assert.equal(persisted.status, "processing"); assert.ok(view.capture(scope, "pending"));
    t.mock.timers.tick(60000); await flush(); assert.equal(calls, 1); stop();
  }
});
