import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { sqliteDatabase } from "../server/database";
import worker from "../worker/index";
import { createSession } from "../worker/auth";
import { createShopOrder, ensureShop, fulfillShopOrder, type ShopPayments, type PaymentReceipt, type ShopOrder } from "../worker/card-shop";
import { alipayPayments, amountFen, signedJsonFields } from "../server/shop-payments";
import { redeemMembership } from "../worker/membership";
import type { Env } from "../worker/types";

const origin = "https://shop.example.test";
const adapter: ShopPayments = { environment: "live", checkout: async () => "https://openapi.alipay.com/gateway.do", notification: async () => { throw new Error("Unsigned"); }, query: async () => null };
async function fixture(t: { after: (fn: () => void) => void }) {
  const local = sqliteDatabase(":memory:"), identity = sqliteDatabase(":memory:");
  t.after(() => { local.sql.close(); identity.sql.close(); });
  const env = { DB: local.db, AUTH_DB: identity.db, ASSETS: { fetch: async () => new Response("asset") }, MEMBERSHIP_ENABLED: "true", SHOP_ENABLED: "true", SHOP_VAULT_KEY: "ab".repeat(32), SHOP_PAYMENTS: adapter } as Env;
  for (const id of ["buyer", "other", "admin"]) identity.sql.prepare("INSERT INTO users(id,name,email,password,created_at) VALUES(?,?,?,?,?)").run(id, id, id + "@example.test", "!test", new Date().toISOString());
  await ensureShop(env);
  identity.sql.exec("INSERT INTO membership_admins VALUES('admin'); INSERT INTO membership_settings VALUES('shop_open','1')");
  async function request(path: string, user = "buyer", method = "GET", value?: unknown, requestOrigin = origin) {
    const cookie = await createSession(new Request(origin), env, user);
    return worker.fetch(new Request(origin + path, { method, headers: { Cookie: cookie.split(";")[0], Origin: requestOrigin, "Content-Type": "application/json" }, ...(value !== undefined ? { body: JSON.stringify(value) } : {}) }), env);
  }
  return { env, local, identity, request };
}
const receipt = (id: string, tradeId = "20261031000000000001"): PaymentReceipt => ({ orderId: id, tradeId, amountFen: 390, state: "paid", environment: "live" });

test("server prices, order idempotency and launch/config gates prevent arbitrary or premature purchases", async t => {
  const f = await fixture(t), key = crypto.randomUUID();
  const [a, b] = await Promise.all([createShopOrder(f.env, "buyer", "week", key), createShopOrder(f.env, "buyer", "week", key)]);
  assert.equal(a.id, b.id); assert.equal(a.amount_fen, 390);
  await assert.rejects(createShopOrder(f.env, "buyer", "month", key), /重新选择/);
  await assert.rejects(createShopOrder({ ...f.env, SHOP_PAYMENTS: undefined }, "buyer", "week", crypto.randomUUID()), /暂未开售/);
  await assert.rejects(createShopOrder({ ...f.env, MEMBERSHIP_LAUNCH_AT: "2099-01-01T00:00:00Z" }, "buyer", "week", crypto.randomUUID()), /暂未开售/);
  await assert.rejects(createShopOrder({ ...f.env, SHOP_VAULT_KEY: "" }, "buyer", "week", crypto.randomUUID()), /暂未开售/);
  for (let i = 0; i < 2; i++) await createShopOrder(f.env, "buyer", "week", crypto.randomUUID());
  await assert.rejects(createShopOrder(f.env, "buyer", "week", crypto.randomUUID()), /待支付订单/);
});

test("a deferred launch blocks new orders, checkout and admin reopening while preserving paid deliveries", async t => {
  const f = await fixture(t), order = await createShopOrder(f.env, "buyer", "week", crypto.randomUUID());
  f.env.MEMBERSHIP_LAUNCH_DEFERRED = "true";
  const shop = await (await f.request("/api/shop")).json();
  assert.equal(shop.launchDeferred, true); assert.equal(shop.launchPending, true); assert.equal(shop.open, false);
  for (const now of [Date.parse("2026-11-02T00:00:00+08:00"), Date.parse("2027-01-01T00:00:00+08:00")])
    await assert.rejects(createShopOrder(f.env, "buyer", "week", crypto.randomUUID(), now), /暂未开售/);
  assert.equal((await f.request(`/api/shop/orders/${order.id}/checkout`, "buyer", "POST", {})).status, 503);
  assert.equal((await f.request("/api/shop/admin/open", "admin", "POST", { open: true })).status, 409);
  assert.equal((await f.request("/api/shop/admin/open", "admin", "POST", { open: false })).status, 200);
  await fulfillShopOrder(f.env, receipt(order.id));
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM shop_orders").get()!.n, 1);
  assert.equal(f.identity.sql.prepare("SELECT status FROM shop_orders").get()!.status, "fulfilled");
  const orders = await (await f.request("/api/shop/orders")).json();
  assert.ok(orders.orders[0].delivery.code);
  await assert.rejects(redeemMembership(f.env, "buyer", orders.orders[0].delivery.code), /具体时间另行通知/);
  f.env.MEMBERSHIP_LAUNCH_DEFERRED = "false";
  assert.equal((await f.request("/api/shop/admin/open", "admin", "POST", { open: true })).status, 200);
});

test("duplicate concurrent payment receipts issue exactly one encrypted code, retrievable only by its buyer", async t => {
  const f = await fixture(t), order = await createShopOrder(f.env, "buyer", "week", crypto.randomUUID());
  await Promise.all(Array.from({ length: 6 }, () => fulfillShopOrder(f.env, receipt(order.id))));
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM membership_cards").get()!.n, 1);
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM shop_payments").get()!.n, 1);
  const response = await f.request("/api/shop/orders"), data = await response.json();
  const code = data.orders[0].delivery.code;
  assert.match(code, /^YY-(?:[A-F0-9]{8}-){3}[A-F0-9]{8}$/);
  assert.equal(String(f.identity.sql.prepare("SELECT encrypted_code FROM shop_deliveries").get()!.encrypted_code).includes(code), false);
  assert.equal((await (await f.request("/api/shop/orders", "other")).json()).orders.length, 0);
  assert.equal((await f.request(`/api/shop/orders/${order.id}/checkout`, "other", "POST", {})).status, 404);
  const adminData = await (await f.request("/api/shop/admin", "admin")).json();
  assert.equal(JSON.stringify(adminData).includes(code), false); assert.equal(adminData.totals.revenueFen, 390);
  await redeemMembership(f.env, "buyer", code);
  assert.ok((await (await f.request("/api/shop/orders")).json()).orders[0].delivery.redeemedAt);
});

test("mismatched amounts, reused payment IDs and sandbox receipts cannot grant cards", async t => {
  const f = await fixture(t), a = await createShopOrder(f.env, "buyer", "week", crypto.randomUUID()), b = await createShopOrder(f.env, "other", "week", crypto.randomUUID());
  await assert.rejects(fulfillShopOrder(f.env, { ...receipt(a.id), amountFen: 1 }), /不匹配/);
  await assert.rejects(fulfillShopOrder(f.env, { ...receipt(a.id), environment: "sandbox" }), /测试支付/);
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM membership_cards").get()!.n, 0);
  await fulfillShopOrder(f.env, receipt(a.id));
  await assert.rejects(fulfillShopOrder(f.env, receipt(b.id)), /UNIQUE/);
  await assert.rejects(fulfillShopOrder(f.env, receipt(a.id, "20261031000000000002")), /流水冲突/);
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM membership_cards").get()!.n, 1);
  assert.equal(f.identity.sql.prepare("SELECT status FROM shop_orders WHERE id=?").get(b.id)!.status, "pending");
});

test("a fulfillment failure rolls back payment, batch, card and delivery, then a retry recovers", async t => {
  const f = await fixture(t), order = await createShopOrder(f.env, "buyer", "week", crypto.randomUUID());
  f.identity.sql.exec("CREATE TRIGGER simulate_failure BEFORE INSERT ON shop_deliveries BEGIN SELECT RAISE(ABORT,'Simulated disk failure'); END");
  await assert.rejects(fulfillShopOrder(f.env, receipt(order.id)), /Simulated/);
  for (const table of ["shop_payments", "membership_cards", "membership_batches", "shop_deliveries"]) assert.equal(f.identity.sql.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n, 0);
  f.identity.sql.exec("DROP TRIGGER simulate_failure");
  await fulfillShopOrder(f.env, receipt(order.id));
  assert.equal(f.identity.sql.prepare("SELECT status FROM shop_orders WHERE id=?").get(order.id)!.status, "fulfilled");
});

test("routes require login, admin role and same-origin mutations; no client-side payment-success route exists", async t => {
  const f = await fixture(t);
  assert.equal((await worker.fetch(new Request(origin + "/api/shop/orders"), f.env)).status, 401);
  assert.equal((await f.request("/api/shop/admin")).status, 403);
  assert.equal((await f.request("/api/shop/admin/open", "admin", "POST", { open: false }, "https://evil.test")).status, 403);
  assert.equal((await f.request("/api/shop/orders", "buyer", "POST", { plan: "week", requestKey: crypto.randomUUID(), amountFen: 1 })).status, 200);
  assert.equal(f.identity.sql.prepare("SELECT amount_fen FROM shop_orders").get()!.amount_fen, 390);
  assert.equal((await f.request("/api/shop/pay-success", "buyer", "POST", { paid: true })).status, 404);
  assert.equal((await worker.fetch(new Request(origin + "/api/shop/alipay/notify", { method: "POST", body: "paid=true" }), f.env)).status, 400);
  f.env.SHOP_PAYMENTS = undefined;
  assert.equal((await f.request("/api/shop/admin/open", "admin", "POST", { open: true })).status, 409);
});

test("Alipay verifies exact RSA2 signatures, app and seller; duplicate fields and altered amounts are rejected", async () => {
  const merchant = generateKeyPairSync("rsa", { modulusLength: 2048 }), provider = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const config = { appId: "2026103100000001", sellerId: "2088123456789012", privateKey: merchant.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), alipayPublicKey: provider.publicKey.export({ type: "spki", format: "pem" }).toString(), siteOrigin: origin };
  const adapter = alipayPayments(config);
  const values = { app_id: config.appId, seller_id: config.sellerId, out_trade_no: "YY" + "A".repeat(32), trade_no: "20261031000000000001", total_amount: "3.90", trade_status: "TRADE_SUCCESS", sign_type: "RSA2" };
  function notification(data = values) {
    const canonical = Object.keys(data).filter(k => k !== "sign_type").sort().map(k => `${k}=${data[k as keyof typeof data]}`).join("&");
    return new URLSearchParams({ ...data, sign: sign("RSA-SHA256", Buffer.from(canonical), provider.privateKey).toString("base64") });
  }
  const request = (form: URLSearchParams) => new Request(origin + "/api/shop/alipay/notify", { method: "POST", body: form });
  assert.equal((await adapter.notification(request(notification()))).amountFen, 390);
  const altered = notification(); altered.set("total_amount", "0.01");
  await assert.rejects(adapter.notification(request(altered)), /signature/);
  const duplicate = notification(); duplicate.append("total_amount", "0.01");
  await assert.rejects(adapter.notification(request(duplicate)), /Duplicate/);
  await assert.rejects(adapter.notification(request(notification({ ...values, seller_id: "2088000000000000" }))), /merchant/);
  await assert.rejects(adapter.notification(request(notification({ ...values, app_id: "2026000000000000" }))), /app/);
  const order = { id: values.out_trade_no, amount_fen: 990, days: 30, expires_at: Date.now() + 60000 } as ShopOrder;
  const checkout = new URL(await adapter.checkout(order, true));
  assert.equal(checkout.origin, "https://openapi.alipay.com");
  assert.equal(JSON.parse(checkout.searchParams.get("biz_content")!).total_amount, "9.90");
  assert.equal(checkout.searchParams.get("notify_url"), origin + "/api/shop/alipay/notify");
  const raw = JSON.stringify({ code: "10000", out_trade_no: values.out_trade_no, trade_no: values.trade_no, total_amount: "9.90", trade_status: "TRADE_SUCCESS", note: { nested: "escaped \\\" } , text" } });
  const sig = sign("RSA-SHA256", Buffer.from(raw), provider.privateKey).toString("base64");
  const queryAdapter = alipayPayments(config, async () => new Response(`{"alipay_trade_query_response":${raw},"sign":${JSON.stringify(sig)}}`));
  assert.equal((await queryAdapter.query(order))!.amountFen, 990);
  const tampered = alipayPayments(config, async () => new Response(`{"alipay_trade_query_response":${raw.replace("9.90", "0.01")},"sign":${JSON.stringify(sig)}}`));
  await assert.rejects(tampered.query(order), /signature/);
  assert.throws(() => signedJsonFields('{"sign":"a","sign":"b"}'), /Duplicate/);
  assert.equal(amountFen("9.9"), 990); assert.equal(amountFen("3.90"), 390);
  assert.throws(() => amountFen("0.001")); assert.throws(() => amountFen("NaN"));
});
