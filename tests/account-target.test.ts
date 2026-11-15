import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import worker from "../worker/index";
import { sqliteDatabase } from "../server/database";
import { migrations } from "../worker/migrations";
import type { Env } from "../worker/types";
import { REGISTRATION_NOTICE_VERSION } from "../src/lib/registration-notice";

const origin = "http://127.0.0.1:8789";
const endpoint = "/api/preferences/target";
const defaultTarget = 11, changedTarget = 13;
function fixture(path = ":memory:") {
  const { sql, db } = sqliteDatabase(path);
  const env: Env = { DB: db, FREE_ACCESS_ENABLED: "true", ASSETS: { fetch: async () => new Response("static") } };
  const request = (path: string, method = "GET", data?: unknown, cookie?: string, from: string | null = origin) => worker.fetch(new Request(origin + path, {
    method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(from === null ? {} : { Origin: from }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  }), env);
  async function login(email: string, register = false) {
    const response = await request("/api/auth", "POST", { action: register ? "register" : "login", email, password: "Synthetic-test-78394", ...(register ? { name: "合成账号", acceptNotice: true, noticeVersion: REGISTRATION_NOTICE_VERSION } : {}) });
    assert.equal(response.status, 200);
    const data = await response.json();
    return { ownerId: data.user.id as string, cookie: response.headers.get("Set-Cookie")!.split(";")[0] };
  }
  return { sql, request, login };
}

test("target preference enforces login, origin, account fence, validation and atomic versions", async () => {
  const f = fixture();
  try {
    assert.equal((await f.request(endpoint)).status, 401);
    assert.equal((await f.request(endpoint, "PUT", {}, undefined, null)).status, 403);
    const a = await f.login("target-a@example.test", true), b = await f.login("target-b@example.test", true);
    const empty = await (await f.request(endpoint, "GET", undefined, a.cookie)).json();
    assert.deepEqual(empty, { ownerId: a.ownerId, target: null, version: 0, updatedAt: null });
    const firstResponse = await f.request(endpoint, "PUT", { ownerId: a.ownerId, target: defaultTarget, expectedVersion: 0 }, a.cookie);
    assert.equal(firstResponse.status, 200); assert.equal(firstResponse.headers.get("Cache-Control"), "no-store");
    const first = await firstResponse.json(); assert.equal(first.target, defaultTarget); assert.equal(first.version, 1);
    const other = await (await f.request(endpoint, "GET", undefined, b.cookie)).json(); assert.equal(other.target, null);
    const crossed = await f.request(endpoint, "PUT", { ownerId: a.ownerId, target: changedTarget, expectedVersion: 1 }, b.cookie);
    assert.equal(crossed.status, 403); assert.equal((await crossed.json()).code, "TARGET_PREFERENCE_OWNER_CHANGED");
    const repeated = await (await f.request(endpoint, "PUT", { ownerId: a.ownerId, target: defaultTarget, expectedVersion: 0 }, a.cookie)).json();
    assert.deepEqual(repeated, first, "lost acknowledgement retry is idempotent");
    const conflict = await f.request(endpoint, "PUT", { ownerId: a.ownerId, target: changedTarget, expectedVersion: 0 }, a.cookie);
    assert.equal(conflict.status, 409); assert.equal((await conflict.json()).preference.target, defaultTarget, "legacy init cannot overwrite an existing cloud preference");
    const next = await (await f.request(endpoint, "PUT", { ownerId: a.ownerId, target: changedTarget, expectedVersion: 1 }, a.cookie)).json(); assert.equal(next.target, changedTarget); assert.equal(next.version, 2);
    const stale = await f.request(endpoint, "PUT", { ownerId: a.ownerId, target: defaultTarget, expectedVersion: 1 }, a.cookie); assert.equal(stale.status, 409);
    for (const target of [0,16,10.5,"11",null]) assert.equal((await f.request(endpoint, "PUT", { ownerId: a.ownerId, target, expectedVersion: 2 }, a.cookie)).status, 400);
    assert.equal((await f.request(endpoint, "PUT", { ownerId: a.ownerId, target: defaultTarget, expectedVersion: 2, user_id: b.ownerId }, a.cookie)).status, 400);
    assert.equal((await f.request(endpoint, "PUT", { ownerId: a.ownerId, target: defaultTarget, expectedVersion: 2 }, a.cookie, "https://unrelated.example")).status, 403);
    assert.equal((await f.request(endpoint, "POST", {}, a.cookie)).status, 405);
    assert.equal((await (await f.request(endpoint, "GET", undefined, a.cookie)).json()).target, changedTarget);
  } finally { f.sql.close(); }
});

test("cloud target survives old dates, process reopen, fresh login and another browser session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "account-target-")), path = join(directory, "prefs.sqlite");
  let f = fixture(path);
  try {
    const account = await f.login("persistent-target@example.test", true);
    const saved = await f.request(endpoint, "PUT", { ownerId: account.ownerId, target: changedTarget, expectedVersion: 0 }, account.cookie); assert.equal(saved.status, 200);
    f.sql.prepare("UPDATE account_target_preferences SET updated_at=? WHERE user_id=?").run("2001-01-01T00:00:00.000Z", account.ownerId);
    assert.equal((await f.request("/api/auth", "POST", { action: "logout" }, account.cookie)).status, 200);
    f.sql.close(); f = fixture(path);
    const freshBrowser = await f.login("persistent-target@example.test"); assert.equal(freshBrowser.ownerId, account.ownerId);
    const recovered = await (await f.request(endpoint, "GET", undefined, freshBrowser.cookie)).json();
    assert.equal(recovered.target, changedTarget); assert.equal(recovered.updatedAt, "2001-01-01T00:00:00.000Z");
    assert.equal((await f.request(endpoint, "GET", undefined, account.cookie)).status, 401);
    const anotherBrowser = await f.login("persistent-target@example.test");
    assert.equal((await (await f.request(endpoint, "GET", undefined, anotherBrowser.cookie)).json()).target, changedTarget);
  } finally {
    f.sql.close();
    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(path + suffix)) unlinkSync(path + suffix);
    rmdirSync(directory);
  }
});

test("preference migration preserves historical rows and never migrates the shared identity binding", () => {
  const identity = sqliteDatabase(":memory:", { identityOnly: true });
  try {
    assert.deepEqual(identity.sql.prepare("SELECT version FROM app_migrations ORDER BY version").all().map(r => r.version), [1]);
    assert.equal(identity.sql.prepare("SELECT name FROM sqlite_master WHERE name='account_target_preferences'").get(), undefined);
  } finally { identity.sql.close(); }
  const directory = mkdtempSync(join(tmpdir(), "account-target-")), path = join(directory, "prefs.sqlite");
  let old: DatabaseSync | null = new DatabaseSync(path);
  try {
    old.exec("PRAGMA foreign_keys=ON;CREATE TABLE app_migrations(version INTEGER PRIMARY KEY)");
    for (const migration of migrations.filter(m => m.version < 3)) { old.exec(migration.sql); old.prepare("INSERT INTO app_migrations VALUES(?)").run(migration.version); }
    old.prepare("INSERT INTO users VALUES(?,?,?,?,?)").run("synthetic-owner", "history@example.test", "合成历史账号", "!not-a-real-password", "2020-01-01");
    old.prepare("INSERT INTO drafts VALUES(?,?,?,?,?,?)").run("synthetic-draft", "synthetic-owner", '{"essay":"Synthetic historical answer"}', 4, "2020-01-01", 3);
    const users = old.prepare("SELECT * FROM users").all(), drafts = old.prepare("SELECT * FROM drafts").all();
    old.close(); old = null;
    const upgraded = sqliteDatabase(path);
    try {
      assert.deepEqual(upgraded.sql.prepare("SELECT * FROM users").all(), users);
      assert.deepEqual(upgraded.sql.prepare("SELECT * FROM drafts").all(), drafts);
      assert.equal(upgraded.sql.prepare("SELECT COUNT(*) n FROM account_target_preferences").get()!.n, 0);
      assert.equal(upgraded.sql.prepare("PRAGMA foreign_key_check").all().length, 0);
      assert.ok(upgraded.sql.prepare("SELECT version FROM app_migrations WHERE version=?").get(3));
    } finally { upgraded.sql.close(); }
    const repeated = sqliteDatabase(path); repeated.sql.close();
  } finally {
    old?.close(); for (const suffix of ["", "-wal", "-shm"]) if (existsSync(path + suffix)) unlinkSync(path + suffix); rmdirSync(directory);
  }
});
