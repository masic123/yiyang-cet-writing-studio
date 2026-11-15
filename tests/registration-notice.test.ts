import { test } from "node:test";
import assert from "node:assert/strict";
import { sqliteDatabase } from "../server/database";
import worker from "../worker/index";
import { REGISTRATION_NOTICE_VERSION } from "../src/lib/registration-notice";

const origin = "https://yiyangcet.xyz";
const credentials = { action: "register", name: "Synthetic notice test", email: "notice@example.test", password: "Disposable-notice-test-42" };
const post = (value: object) => new Request(origin + "/api/auth", {
  method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(value),
});
const consent = { acceptNotice: true, noticeVersion: REGISTRATION_NOTICE_VERSION };

test("registration rejects missing, false, malformed or outdated acceptance without creating an account or session", async () => {
  const local = sqliteDatabase(":memory:");
  const env = { DB: local.db, ASSETS: { fetch: async () => new Response("page") } };
  try {
    for (const extra of [{}, { acceptNotice: false }, { acceptNotice: "true", noticeVersion: REGISTRATION_NOTICE_VERSION }, { acceptNotice: true }, { acceptNotice: true, noticeVersion: "previous-version" }]) {
      const response = await worker.fetch(post({ ...credentials, ...extra }), env);
      assert.equal(response.status, 400);
      assert.equal(response.headers.has("set-cookie"), false);
      assert.equal(local.sql.prepare("SELECT COUNT(*) n FROM users").get()?.n, 0);
      assert.equal(local.sql.prepare("SELECT COUNT(*) n FROM sessions").get()?.n, 0);
    }
  } finally { local.sql.close(); }
});

test("accepted registration records a server timestamp and version with the shared identity and preserves login", async () => {
  const local = sqliteDatabase(":memory:"), identity = sqliteDatabase(":memory:", { identityOnly: true });
  const env = { DB: local.db, AUTH_DB: identity.db, ASSETS: { fetch: async () => new Response("page") } };
  try {
    const before = Date.now();
    const registered = await worker.fetch(post({ ...credentials, ...consent }), env);
    assert.equal(registered.status, 200);
    const user = (await registered.json()).user;
    const receipt = identity.sql.prepare("SELECT * FROM registration_notice_acceptances WHERE user_id=?").get(user.id)!;
    assert.equal(receipt.site, "cet");
    assert.equal(receipt.notice_version, REGISTRATION_NOTICE_VERSION);
    assert.ok(Date.parse(String(receipt.accepted_at)) >= before && Date.parse(String(receipt.accepted_at)) <= Date.now());
    assert.equal(local.sql.prepare("SELECT name FROM sqlite_master WHERE name='registration_notice_acceptances'").get(), undefined);
    const duplicate = await worker.fetch(post({ ...credentials, ...consent }), env);
    assert.equal(duplicate.status, 409);
    assert.equal(identity.sql.prepare("SELECT COUNT(*) n FROM registration_notice_acceptances").get()?.n, 1);
    const loggedIn = await worker.fetch(post({ action: "login", email: credentials.email, password: credentials.password }), env);
    assert.equal(loggedIn.status, 200);
    assert.equal((await loggedIn.json()).user.id, user.id);
    assert.equal(identity.sql.prepare("SELECT COUNT(*) n FROM registration_notice_acceptances").get()?.n, 1);
    identity.sql.prepare("INSERT INTO users VALUES('legacy','legacy@example.test','Legacy',?,'before-notice')").run(identity.sql.prepare("SELECT password FROM users WHERE id=?").get(user.id)!.password);
    const legacyLogin = await worker.fetch(post({ action: "login", email: "legacy@example.test", password: credentials.password }), env);
    assert.equal(legacyLogin.status, 200);
    assert.equal(identity.sql.prepare("SELECT COUNT(*) n FROM registration_notice_acceptances WHERE user_id='legacy'").get()?.n, 0);
  } finally { identity.sql.close(); local.sql.close(); }
});

test("a failed acceptance write rolls back account creation", async () => {
  const local = sqliteDatabase(":memory:");
  const env = { DB: local.db, ASSETS: { fetch: async () => new Response("page") } };
  try {
    const first = await worker.fetch(post({ ...credentials, ...consent }), env);
    assert.equal(first.status, 200);
    local.sql.exec("CREATE TRIGGER reject_test_receipt BEFORE INSERT ON registration_notice_acceptances BEGIN SELECT RAISE(ABORT,'Synthetic receipt failure'); END");
    const failed = await worker.fetch(post({ ...credentials, ...consent, email: "failed@example.test" }), env);
    assert.equal(failed.status, 503);
    assert.equal(local.sql.prepare("SELECT id FROM users WHERE email='failed@example.test'").get(), undefined);
    assert.equal(local.sql.prepare("SELECT COUNT(*) n FROM registration_notice_acceptances").get()?.n, 1);
    assert.equal(local.sql.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
  } finally { local.sql.close(); }
});
