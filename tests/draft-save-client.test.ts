import { test } from "node:test";
import assert from "node:assert/strict";
import { createDraftSaveFlight, reconcileLocalDraftMeta, sameDraftInput, savedDraftSwitchStatus } from "../src/lib/draft-save-client";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("input equality ignores object ordering without changing answer text or notes", () => {
  assert.equal(sameDraftInput({ essay: "Exact answer.\n", outline: { ending: "Keep", parts: [1, 2] } }, { outline: { parts: [1, 2], ending: "Keep" }, essay: "Exact answer.\n" }), true);
  assert.equal(sameDraftInput({ essay: "Exact answer.\n" }, { essay: "Exact answer." }), false);
  assert.equal(sameDraftInput({ notes: [1, 2] }, { notes: [2, 1] }), false);
});

test("local recovery matches its own cloud draft and adopts a newer identical version", () => {
  const input = { essay: "Local answer", title: "A" };
  const local = { input, meta: { id: "a", version: 1 } };
  assert.deepEqual(reconcileLocalDraftMeta(local, [{ id: "b", version: 20, input: { essay: "Unrelated" } }, { id: "a", version: 4, input: { title: "A", essay: "Local answer" } }]), { meta: { id: "a", version: 4 }, detached: false });
  assert.deepEqual(local, { input, meta: { id: "a", version: 1 } });
});

test("different stale local answers detach safely while an ordinary unsaved edit keeps its base version", () => {
  const local = { input: { essay: "Local unsaved answer" }, meta: { id: "a", version: 1 } };
  assert.deepEqual(reconcileLocalDraftMeta(local, [{ id: "a", version: 2, input: { essay: "Other page answer" } }]), { meta: null, detached: true });
  assert.deepEqual(reconcileLocalDraftMeta(local, [{ id: "a", version: 1, input: { essay: "Saved base answer" } }]), { meta: { id: "a", version: 1 }, detached: false });
  assert.deepEqual(reconcileLocalDraftMeta(local, []), { meta: null, detached: true });
  assert.equal(local.input.essay, "Local unsaved answer");
});

test("same-tick duplicate saves share one request and a different snapshot cannot race it", async () => {
  const flight = createDraftSaveFlight<number>();
  const result = deferred<number>();
  let calls = 0;
  const operation = () => { calls++; return result.promise; };
  const first = flight.run("owner:exercise", "snapshot", operation);
  const second = flight.run("owner:exercise", "snapshot", operation);
  assert.equal(first, second);
  assert.equal(flight.busy("owner:exercise"), true);
  await assert.rejects(flight.run("owner:exercise", "new typing", operation), /正在保存/);
  assert.equal(calls, 1);
  result.resolve(2);
  assert.deepEqual(await Promise.all([first, second]), [2, 2]);
  assert.equal(flight.busy("owner:exercise"), false);
});

test("a late old-context completion cannot release the new account or exercise's save lock", async () => {
  const flight = createDraftSaveFlight<number>();
  const oldResult = deferred<number>(), newResult = deferred<number>();
  const oldSave = flight.run("old-owner:exercise", "old", () => oldResult.promise);
  const newSave = flight.run("new-owner:exercise", "new", () => newResult.promise);
  oldResult.resolve(1);
  await oldSave;
  assert.equal(flight.busy("new-owner:exercise"), true);
  assert.equal(flight.run("new-owner:exercise", "new", () => Promise.resolve(99)), newSave);
  newResult.resolve(2);
  assert.equal(await newSave, 2);
  assert.equal(flight.busy("new-owner:exercise"), false);
});

test("failed saves release their lock so an explicit retry or copy can proceed", async () => {
  const flight = createDraftSaveFlight<number>();
  await assert.rejects(flight.run("owner:exercise", "save", async () => { throw new Error("conflict"); }), /conflict/);
  assert.equal(flight.busy("owner:exercise"), false);
  assert.equal(await flight.run("owner:exercise", "copy", async () => 3), 3);
});

test("leaving a saved draft requires both the same context and the unchanged full input", () => {
  const input = { essay: "Original answer", outline: { ending: "Original notes" }, title: "Practice" };
  const saved = { scope: "owner:exercise", input: structuredClone(input) };
  assert.equal(savedDraftSwitchStatus(saved, { scope: "owner:exercise", input: { title: "Practice", outline: { ending: "Original notes" }, essay: "Original answer" } }), "ready");
  assert.equal(savedDraftSwitchStatus(saved, { scope: "other-owner:exercise", input }), "stale");
  input.outline.ending = "Notes typed while saving";
  assert.equal(savedDraftSwitchStatus(saved, { scope: "owner:exercise", input }), "changed");
  assert.equal(saved.input.outline.ending, "Original notes");
});

test("typing during the pending save cancels a switch instead of clearing the latest answer", async () => {
  const flight = createDraftSaveFlight<number>();
  const pending = deferred<number>();
  let current = { scope: "owner:exercise", input: { essay: "Answer before saving" } };
  let switched = false;
  const switchExercise = async () => {
    const saved = structuredClone(current);
    await flight.run(saved.scope, JSON.stringify(saved.input), () => pending.promise);
    const status = savedDraftSwitchStatus(saved, current);
    if (status === "ready") { switched = true; current = { scope: "owner:next", input: { essay: "" } }; }
    return status;
  };
  const transition = switchExercise();
  current = { ...current, input: { essay: "Answer plus new typing" } };
  pending.resolve(2);
  assert.equal(await transition, "changed");
  assert.equal(switched, false);
  assert.equal(current.input.essay, "Answer plus new typing");
});
