import { test } from "node:test";
import assert from "node:assert/strict";
import { createTargetPreferenceSync, type TargetPreference, type TargetSyncState } from "../src/lib/target-preference-sync";

const row = (ownerId: string, target: number | null, version = target === null ? 0 : 1): TargetPreference =>
  ({ ownerId, target, version, updatedAt: target === null ? null : "2026-11-04T00:00:00Z" });
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const conflict = () => Object.assign(new Error("conflict"), { status: 409 });
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.ok(check(), "account target synchronization did not settle");
}
function fixture(overrides: {
  remote?: Map<string, TargetPreference>;
  local?: Map<string | null, number>;
  read?: (owner: string, signal: AbortSignal) => Promise<TargetPreference>;
  write?: (owner: string, target: number, version: number, signal: AbortSignal) => Promise<TargetPreference>;
} = {}) {
  const remote = overrides.remote || new Map<string, TargetPreference>();
  const local = overrides.local || new Map<string | null, number>();
  const states: TargetSyncState[] = [], applied: { owner: string | null; target: number }[] = [];
  const writes: { owner: string; target: number; version: number }[] = [];
  let reads = 0;
  const client = createTargetPreferenceSync({
    defaultTarget: 11, valid: n => Number.isInteger(n) && n >= 1 && n <= 15,
    readLocal: owner => local.get(owner) ?? null,
    writeLocal: (owner, target) => { local.set(owner, target); },
    read: async (owner, signal) => { reads++; return overrides.read ? overrides.read(owner, signal) : remote.get(owner) || row(owner, null); },
    write: async (owner, target, version, signal) => {
      writes.push({ owner, target, version });
      if (overrides.write) return overrides.write(owner, target, version, signal);
      const current = remote.get(owner) || row(owner, null);
      if (current.target === target) return current;
      if (current.version !== version) throw conflict();
      const next = row(owner, target, version + 1);
      remote.set(owner, next);
      return next;
    },
    changed: state => states.push(state),
    apply: (target, owner) => applied.push({ owner, target }),
  });
  return { client, remote, local, states, applied, writes, reads: () => reads };
}

test("an account goal survives a new client with empty browser storage", async () => {
  const first = fixture();
  first.client.setOwner("A");
  await until(() => first.client.snapshot().status === "default");
  first.client.choose(13);
  await until(() => first.client.snapshot().status === "saved");
  first.client.stop();
  const second = fixture({ remote: first.remote });
  second.client.setOwner("A");
  await until(() => second.client.snapshot().status === "saved");
  assert.equal(second.client.valueFor("A"), 13);
  assert.equal(second.writes.length, 0);
});

test("a cloud goal overrides the account's old local goal, and guests never write the account API", async () => {
  const f = fixture({ remote: new Map([["A", row("A", 9)]]), local: new Map([["A", 14]]) });
  f.client.setOwner(null); f.client.choose(12);
  assert.equal(f.client.valueFor(null), 12);
  assert.equal(f.reads(), 0); assert.equal(f.writes.length, 0);
  f.client.setOwner("A");
  await until(() => f.client.snapshot().status === "saved");
  assert.equal(f.client.valueFor("A"), 9);
  assert.equal(f.local.get("A"), 9);
  assert.equal(f.writes.length, 0);
});

test("rapid selections are serialized and intermediate queued values are coalesced", async () => {
  const firstWrite = deferred<TargetPreference>();
  let count = 0;
  const f = fixture({
    remote: new Map([["A", row("A", 8, 2)]]),
    write: async (owner, target, version) => ++count === 1 ? firstWrite.promise : row(owner, target, version + 1),
  });
  f.client.setOwner("A"); await until(() => f.client.snapshot().status === "saved");
  f.client.choose(11); f.client.choose(12); f.client.choose(13);
  assert.equal(f.writes.length, 1);
  firstWrite.resolve(row("A", 11, 3));
  await until(() => f.client.snapshot().status === "saved");
  assert.deepEqual(f.writes.map(w => [w.target, w.version]), [[11, 2], [13, 3]]);
  assert.equal(f.client.valueFor("A"), 13);
  assert.equal(f.applied.at(-1)?.target, 13);
  assert.equal(f.applied.slice(3).some(a => a.target === 11), false);
});

test("a late initial response cannot replace a newer explicit selection", async () => {
  const read = deferred<TargetPreference>();
  const f = fixture({ remote: new Map([["A", row("A", 7, 4)]]), read: async () => read.promise });
  f.client.setOwner("A"); f.client.choose(12); f.client.choose(14);
  read.resolve(row("A", 7, 4));
  await until(() => f.client.snapshot().status === "saved");
  assert.equal(f.client.valueFor("A"), 14);
  assert.deepEqual(f.writes.map(w => [w.target, w.version]), [[14, 4]]);
});

test("a stale account read or write cannot change the next account's target or status", async () => {
  const oldRead = deferred<TargetPreference>(), oldWrite = deferred<TargetPreference>();
  const f = fixture({
    read: async owner => owner === "A" ? oldRead.promise : row(owner, 9),
    write: async () => oldWrite.promise,
  });
  f.client.setOwner("A"); f.client.setOwner("B");
  await until(() => f.client.snapshot().status === "saved");
  oldRead.resolve(row("A", 14));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.client.valueFor("B"), 9);
  assert.equal(f.client.snapshot().ownerId, "B");
  assert.equal(f.writes.length, 0);
  f.client.choose(12);
  f.client.setOwner("C"); await until(() => f.client.snapshot().status === "saved");
  oldWrite.resolve(row("B", 12, 2));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.client.valueFor("C"), 9);
  assert.equal(f.client.snapshot().ownerId, "C");
  assert.deepEqual(f.writes.map(w => w.owner), ["B"]);
});

test("a focus-refresh response cannot overwrite a selection made while that read was in flight", async () => {
  const refresh = deferred<TargetPreference>();
  let count = 0;
  const remote = new Map([["A", row("A", 8)]]);
  const f = fixture({ remote, read: async owner => ++count === 1 ? remote.get(owner)! : refresh.promise });
  f.client.setOwner("A"); await until(() => f.client.snapshot().status === "saved");
  const reading = f.client.refresh();
  f.client.choose(13);
  await until(() => f.client.snapshot().status === "saved");
  refresh.resolve(row("A", 8));
  await reading;
  assert.equal(f.client.valueFor("A"), 13);
  assert.equal(f.client.snapshot().status, "saved");
  f.client.choose(14);
  await until(() => f.client.snapshot().status === "saved");
  assert.deepEqual(f.writes.map(w => [w.target, w.version]), [[13, 1], [14, 2]]);
});

test("the same version cannot silently describe a different confirmed target", async () => {
  let count = 0;
  const f = fixture({ read: async owner => row(owner, ++count === 1 ? 8 : 9, 2) });
  f.client.setOwner("A"); await until(() => f.client.snapshot().status === "saved");
  await f.client.refresh();
  assert.equal(f.client.snapshot().status, "error");
  assert.equal(f.client.valueFor("A"), 8);
  assert.equal(f.writes.length, 0);
});

test("an initialization conflict accepts the first cloud value rather than overwriting it with old cache", async () => {
  const remote = new Map<string, TargetPreference>();
  const f = fixture({
    remote, local: new Map([["A", 12]]),
    write: async owner => { remote.set(owner, row(owner, 14)); throw conflict(); },
  });
  f.client.setOwner("A");
  await until(() => f.client.snapshot().status === "saved");
  assert.equal(f.client.valueFor("A"), 14);
  assert.deepEqual(f.writes.map(w => [w.target, w.version]), [[12, 0]]);
});

test("only a still-pending explicit selection retries against a concurrent cloud version", async () => {
  const remote = new Map([["A", row("A", 8)]]);
  let count = 0;
  const f = fixture({
    remote,
    write: async (owner, target, version) => {
      if (++count === 1) { remote.set(owner, row(owner, 9, 2)); throw conflict(); }
      const next = row(owner, target, version + 1); remote.set(owner, next); return next;
    },
  });
  f.client.setOwner("A"); await until(() => f.client.snapshot().status === "saved");
  f.client.choose(12);
  await until(() => f.client.snapshot().status === "saved");
  assert.equal(f.client.valueFor("A"), 12);
  assert.deepEqual(f.writes.map(w => [w.target, w.version]), [[12, 1], [12, 2]]);
});

test("a failed acknowledgement stays unsynced; retry recognizes a server commit without an extra write", async () => {
  const remote = new Map([["A", row("A", 8)]]);
  const f = fixture({
    remote,
    write: async (owner, target, version) => { remote.set(owner, row(owner, target, version + 1)); throw new Error("connection lost"); },
  });
  f.client.setOwner("A"); await until(() => f.client.snapshot().status === "saved");
  f.client.choose(12);
  await until(() => f.client.snapshot().status === "error");
  assert.equal(f.client.valueFor("A"), 12);
  assert.equal(f.local.get("A"), 12);
  await f.client.retry();
  assert.equal(f.client.snapshot().status, "saved");
  assert.equal(f.writes.length, 1);
});

test("an owner-mismatched account response is rejected without applying it or writing a goal", async () => {
  const f = fixture({ read: async () => row("other-account", 15) });
  f.client.setOwner("A");
  await until(() => f.client.snapshot().status === "error");
  assert.equal(f.client.valueFor("A"), 11);
  assert.equal(f.writes.length, 0);
  assert.equal(f.applied.some(a => a.target === 15), false);
});

test("browser-storage failures do not prevent a confirmed account save", async () => {
  let saved = row("A", null);
  const client = createTargetPreferenceSync({
    defaultTarget: 11, valid: n => Number.isInteger(n) && n >= 1 && n <= 15,
    readLocal: () => { throw new Error("storage disabled"); },
    writeLocal: () => { throw new Error("storage disabled"); },
    read: async () => saved,
    write: async (owner, target, version) => saved = row(owner, target, version + 1),
    changed: () => {}, apply: () => {},
  });
  client.setOwner("A"); await until(() => client.snapshot().status === "default");
  client.choose(13); await until(() => client.snapshot().status === "saved");
  assert.equal(saved.target, 13);
  assert.equal(client.valueFor("A"), 13);
});
