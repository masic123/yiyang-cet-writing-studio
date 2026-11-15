import { test } from "node:test";
import assert from "node:assert/strict";
import type { D1Database } from "@cloudflare/workers-types";
import { sqliteDatabase } from "../server/database";
import { createSession } from "../worker/auth";
import { createShopOrder, ensureShop, fulfillShopOrder, type PaymentReceipt, type ShopPayments } from "../worker/card-shop";
import worker from "../worker/index";
import type { Env } from "../worker/types";

const origin = "https://free-shop.example.test";
const receipt = (orderId: string, tradeId = "20261103000000000001"): PaymentReceipt => ({ orderId, tradeId, amountFen: 390, state: "paid", environment: "live" });

test("a free public shop returns no plans and rejects orders before touching the database", async () => {
  const unavailable = { prepare() { throw new Error("Unexpected shop query"); }, batch() { throw new Error("Unexpected shop mutation"); } } as unknown as D1Database;
  const env = { DB: unavailable, AUTH_DB: unavailable, ASSETS: { fetch: async () => new Response("asset") }, FREE_ACCESS_ENABLED: "true", MEMBERSHIP_ENABLED: "true", SHOP_ENABLED: "true" } as Env;
  const response = await worker.fetch(new Request(origin + "/api/shop"), env);
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.open, false);
  assert.equal(state.freeAccess, true);
  assert.deepEqual(state.plans, []);
  for (const path of ["/api/shop/orders", "/api/shop/orders/YY" + "A".repeat(32) + "/checkout", "/api/shop/admin/open"]) {
    const blocked = await worker.fetch(new Request(origin + path, { method: "POST" }), env);
    assert.equal(blocked.status, 410, path);
    assert.equal((await blocked.json()).code, "FREE_ACCESS_ENABLED");
  }
  await assert.rejects(createShopOrder(env, "buyer", "week", crypto.randomUUID()), /免费开放/);
});

test("free mode keeps historical payment verification idempotent without issuing cards or changing entitlements", async t => {
  const local = sqliteDatabase(":memory:"), identity = sqliteDatabase(":memory:");
  t.after(() => { local.sql.close(); identity.sql.close(); });
  let payment: PaymentReceipt | null = null;
  let checkouts = 0;
  const payments: ShopPayments = {
    environment: "live",
    checkout: async () => { checkouts++; return "https://openapi.alipay.com/gateway.do"; },
    query: async () => payment,
    notification: async request => {
      if (request.headers.get("X-Test-Signature") !== "verified" || !payment) throw new Error("Invalid provider signature");
      return payment;
    },
  };
  const env = { DB: local.db, AUTH_DB: identity.db, ASSETS: { fetch: async () => new Response("asset") }, MEMBERSHIP_ENABLED: "true", SHOP_ENABLED: "true", SHOP_VAULT_KEY: "ab".repeat(32), SHOP_PAYMENTS: payments } as Env;
  identity.sql.prepare("INSERT INTO users(id,name,email,password,created_at) VALUES('buyer','Buyer','buyer@example.test','!test',?)").run(new Date().toISOString());
  await ensureShop(env);
  identity.sql.exec("INSERT INTO membership_settings(key,value) VALUES('shop_open','1')");
  const old = await createShopOrder(env, "buyer", "week", crypto.randomUUID());
  const cookie = (await createSession(new Request(origin), env, "buyer")).split(";")[0];
  env.FREE_ACCESS_ENABLED = "true";
  const request = (path: string, method = "GET") => worker.fetch(new Request(origin + path, { method, headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) }), env);
  assert.equal((await request("/api/shop/orders")).status, 200);
  assert.equal((await request(`/api/shop/orders/${old.id}/checkout`, "POST")).status, 410);
  assert.equal(checkouts, 0);
  await assert.rejects(createShopOrder(env, "buyer", "week", old.request_key), /免费开放/);
  const bad = await worker.fetch(new Request(origin + "/api/shop/alipay/notify", { method: "POST" }), env);
  assert.equal(bad.status, 400);
  assert.equal(identity.sql.prepare("SELECT COUNT(*) AS n FROM shop_payments").get()!.n, 0);
  payment = receipt(old.id);
  await assert.rejects(fulfillShopOrder(env, { ...payment, amountFen: 1 }), /不匹配/);
  await assert.rejects(fulfillShopOrder(env, { ...payment, environment: "sandbox" }), /测试支付/);
  assert.equal((await request(`/api/shop/orders/${old.id}/sync`, "POST")).status, 200);
  await Promise.all(Array.from({ length: 5 }, () => fulfillShopOrder(env, payment!)));
  const notification = await worker.fetch(new Request(origin + "/api/shop/alipay/notify", { method: "POST", headers: { "X-Test-Signature": "verified" } }), env);
  assert.equal(notification.status, 200);
  assert.equal(await notification.text(), "success");
  assert.equal(identity.sql.prepare("SELECT COUNT(*) AS n FROM shop_payments").get()!.n, 1);
  const saved = identity.sql.prepare("SELECT status,paid_at FROM shop_orders WHERE id=?").get(old.id)!;
  assert.equal(saved.status, "pending");
  assert.ok(saved.paid_at);
  for (const table of ["membership_cards", "membership_batches", "membership_accounts", "membership_events", "shop_deliveries"])
    assert.equal(identity.sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 0, table);
  assert.equal(identity.sql.prepare("SELECT value FROM membership_settings WHERE key='shop_open'").get()!.value, "1");
  await assert.rejects(fulfillShopOrder(env, receipt(old.id, "20261103000000000002")), /流水冲突/);
  assert.equal(identity.sql.prepare("SELECT trade_id FROM shop_payments").get()!.trade_id, "20261103000000000001");
});
