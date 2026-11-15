import { test } from "node:test";
import assert from "node:assert/strict";
import { sqliteDatabase } from "../server/database";
import worker from "../worker/index";
import { createSession, digest } from "../worker/auth";
import { membershipStatus } from "../worker/membership";
import { ensurePromotions } from "../worker/promotion";
import type { Env } from "../worker/types";

async function fixture(t: { after: (fn: () => void) => void }) {
  const identity = sqliteDatabase(":memory:"), app = sqliteDatabase(":memory:");
  t.after(() => { app.sql.close(); identity.sql.close(); });
  const env = { DB: app.db, AUTH_DB: identity.db, MEMBERSHIP_ENABLED: "true", ASSETS: { fetch: async () => new Response("asset") } } as Env;
  for (const id of ["admin", "blogger", "invited", "ordinary"]) {
    identity.sql.prepare("INSERT INTO users(id,name,email,password,created_at) VALUES(?,?,?,?,?)").run(id, id, `${id}@example.test`, "!test", "2026-11-02T00:30:00+08:00");
    await membershipStatus(env, id);
  }
  await ensurePromotions(env);
  identity.sql.prepare("INSERT INTO membership_admins(user_id) VALUES('admin')").run();
  const code = identity.sql.prepare("SELECT referral_code FROM membership_accounts WHERE user_id='blogger'").get()!.referral_code;
  identity.sql.prepare("INSERT INTO membership_settings(key,value) VALUES('week_buy_url','https://catfk.com/item/vlvk99'),('month_buy_url','https://catfk.com/item/4h8nqk')").run();
  identity.sql.prepare("INSERT INTO promotion_campaigns(inviter_id,referral_code,created_at,week_buy_url,month_buy_url) VALUES('blogger',?,?,?,?)").run(code, Date.now(), "https://catfk.com/item/syntheticweek85", "https://catfk.com/item/syntheticmonth85");
  identity.sql.prepare("INSERT INTO membership_invites(invitee_id,inviter_id,created_at) VALUES('invited','blogger',?)").run(Date.now());
  const request = async (id: string | null, path: string) => {
    const cookie = id ? await createSession(new Request("https://writing.example"), env, id) : "";
    return worker.fetch(new Request(`https://writing.example${path}`, { headers: cookie ? { Cookie: cookie.split(";")[0] } : {} }), env);
  };
  return { env, identity, request };
}

test("membership exposes rounded 85% prices only to a bound invitee, across both sites", async t => {
  const f = await fixture(t);
  for (const site of ["cet", "ielts"]) {
    const member = await membershipStatus({ ...f.env, MEMBERSHIP_SITE: site }, "invited");
    assert.deepEqual(member.plans.map(value => (value as typeof value & {discountPrice?:number}).discountPrice), [3.32, 8.42]);
    assert.deepEqual(member.plans.map(value => value.price), [3.9, 9.9]); // legacy clients retain honest base quotes
    assert.deepEqual(member.plans.map(value => (value as typeof value & {discountBuyUrl?:string}).discountBuyUrl), ["/api/membership/promotion-checkout?plan=week", "/api/membership/promotion-checkout?plan=month"]);
    assert.deepEqual(member.plans.map(value => value.buyUrl), ["https://catfk.com/item/vlvk99", "https://catfk.com/item/4h8nqk"]);
    assert.equal(member.promotion?.ready, true);
    assert.equal(JSON.stringify(member).includes("blogger@example.test"), false);
  }
  for (const id of [undefined, "ordinary", "blogger"]) {
    const member = await membershipStatus(f.env, id);
    assert.deepEqual(member.plans.map(value => value.price), [3.9, 9.9]);
  }
  f.identity.sql.prepare("UPDATE promotion_campaigns SET enabled=0").run();
  assert.deepEqual((await membershipStatus(f.env, "invited")).plans.map(value => value.price), [3.9, 9.9]);
});

test("promotion list endpoint permits admins only and never trusts caller owner parameters", async t => {
  const f = await fixture(t);
  assert.equal((await f.request(null, "/api/membership/promotions")).status, 401);
  for (const id of ["blogger", "ordinary", "invited"]) {
    assert.equal((await f.request(id, "/api/membership/promotions?owner=admin&userId=admin")).status, 403);
  }
  const response = await f.request("admin", "/api/membership/promotions");
  assert.equal(response.status, 200); assert.equal(response.headers.get("Cache-Control"), "no-store");
  const report = await response.json();
  assert.equal(report.summary.registeredUsers, 1);
  assert.equal(report.summary.saleRedeemedUsers, 0);
  assert.equal(report.users[0].email, "invited@example.test");
  assert.equal(report.paymentBasis, "sale-card-redemption");
  assert.equal((await f.request("admin", "/api/membership/promotions?offset=NaN")).status, 400);
});

test("the complete worker routes the scoped shared report before requiring a login", async t => {
  const f = await fixture(t), token = "ab".repeat(32);
  f.identity.sql.prepare("INSERT INTO promotion_shares(token_hash,inviter_id,created_at) VALUES(?,'blogger',?)").run(await digest(token), Date.now());
  const response = await worker.fetch(new Request("https://writing.example/api/membership/promotion-share?owner=admin&inviterId=ordinary", { headers: { Authorization: `Bearer ${token}` } }), f.env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  const report = await response.json();
  assert.equal(report.users.length, 1);
  assert.equal(report.users[0].email, "in***@example.test");
  assert.equal("userId" in report.users[0], false);
  assert.equal("campaigns" in report, false);
  assert.equal((await worker.fetch(new Request("https://writing.example/api/membership/promotion-share"), f.env)).status, 401);
});

test("dedicated checkout validates the logged-in invitee before redirecting and ignores caller IDs/codes", async t => {
  const f = await fixture(t);
  const path = "/api/membership/promotion-checkout?plan=week";
  assert.equal((await f.request(null, path)).status, 401);
  assert.equal((await f.request("ordinary", `${path}&userId=invited&inviterId=blogger&invite=E6BAB92C43`)).status, 403);
  assert.equal((await f.request("blogger", path)).status, 403);
  const week = await f.request("invited", path);
  assert.equal(week.status, 302);
  assert.equal(week.headers.get("Location"), "https://catfk.com/item/syntheticweek85");
  assert.equal(week.headers.get("Cache-Control"), "no-store");
  assert.equal(week.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal((await f.request("invited", "/api/membership/promotion-checkout?plan=month")).headers.get("Location"), "https://catfk.com/item/syntheticmonth85");
  assert.equal((await f.request("invited", "/api/membership/promotion-checkout?plan=year")).status, 400);
  f.identity.sql.prepare("UPDATE promotion_campaigns SET enabled=0").run();
  assert.equal((await f.request("invited", path)).status, 403);
});

test("dedicated checkout rejects existing permanent VIP and paused sales without mutating stock", async t => {
  const f = await fixture(t), path = "/api/membership/promotion-checkout?plan=week";
  f.identity.sql.prepare("INSERT INTO membership_permanent(user_id,granted_at) VALUES('invited',?)").run(Date.now());
  assert.equal((await f.request("invited", path)).status, 400);
  f.env.MEMBERSHIP_REQUIRE_READY = "true";
  assert.equal((await f.request("invited", path)).status, 503);
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM membership_cards").get()!.n, 0);
});
