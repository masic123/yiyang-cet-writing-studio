import type { D1Database } from "@cloudflare/workers-types";
import type { Env } from "./types";
import { currentUser, digest, rateLimit, requireUser } from "./auth";
import { ensureMembership, freeAccessEnabled, membershipEnabled, membershipLaunchAt, membershipLaunchDeferred, membershipLaunchPending } from "./membership";
import { HttpError, assertOrigin, body } from "../src/lib/http";

export type ShopOrder = { id: string; user_id: string; request_key: string; plan: string; days: number; amount_fen: number; status: "pending" | "fulfilled"; created_at: number; expires_at: number; paid_at: number | null };
export type PaymentReceipt = { orderId: string; tradeId: string; amountFen: number; state: "paid" | "pending" | "closed"; environment: "live" | "sandbox" };
export type ShopPayments = {
  environment: "live" | "sandbox";
  checkout: (order: ShopOrder, mobile: boolean) => Promise<string>;
  notification: (request: Request) => Promise<PaymentReceipt>;
  query: (order: ShopOrder) => Promise<PaymentReceipt | null>;
};
export const shopPlans = [
  { id: "week", name: "周卡", days: 7, amountFen: 390, dailyPrice: "0.56" },
  { id: "month", name: "月卡", days: 30, amountFen: 990, dailyPrice: "0.33" },
] as const;
const schemas = new WeakMap<D1Database, Promise<unknown>>();
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const freeAccessError = () => new HttpError(410, "会员制度已取消，现已免费开放，不再接受新购买。", "FREE_ACCESS_ENABLED");

export async function ensureShop(env: Env) {
  const db = await ensureMembership(env);
  if (!schemas.has(db)) {
    const statements = [
      "CREATE TABLE IF NOT EXISTS shop_orders(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),request_key TEXT NOT NULL,plan TEXT NOT NULL CHECK(plan IN ('week','month')),days INTEGER NOT NULL CHECK(days IN (7,30)),amount_fen INTEGER NOT NULL CHECK(amount_fen>0),status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','fulfilled')),environment TEXT NOT NULL CHECK(environment IN ('live','sandbox')),created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,paid_at INTEGER,UNIQUE(user_id,request_key))",
      "CREATE INDEX IF NOT EXISTS shop_orders_owner ON shop_orders(user_id,created_at DESC)",
      "CREATE TABLE IF NOT EXISTS shop_payments(order_id TEXT PRIMARY KEY REFERENCES shop_orders(id),trade_id TEXT NOT NULL UNIQUE,amount_fen INTEGER NOT NULL,created_at INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS shop_deliveries(order_id TEXT PRIMARY KEY REFERENCES shop_orders(id),code_hash TEXT NOT NULL UNIQUE REFERENCES membership_cards(code_hash),encrypted_code TEXT NOT NULL,created_at INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS shop_audit(id TEXT PRIMARY KEY,actor TEXT NOT NULL REFERENCES users(id),action TEXT NOT NULL,target TEXT NOT NULL,created_at INTEGER NOT NULL)",
    ];
    schemas.set(db, db.batch(statements.map(sql => db.prepare(sql))).catch(error => { schemas.delete(db); throw error; }));
  }
  await schemas.get(db);
  return db;
}

async function vault(env: Env) {
  if (!/^[a-f0-9]{64}$/i.test(env.SHOP_VAULT_KEY || "")) throw new HttpError(503, "订单服务暂未配置完成。");
  const bytes = new Uint8Array(env.SHOP_VAULT_KEY!.match(/../g)!.map(x => parseInt(x, 16)));
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function encryptCode(env: Env, orderId: string, code: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(orderId) }, await vault(env), new TextEncoder().encode(code));
  return ["v1", Buffer.from(iv).toString("base64"), Buffer.from(encrypted).toString("base64")].join(":");
}
async function decryptCode(env: Env, orderId: string, value: string) {
  const [version, iv, encrypted] = value.split(":");
  if (version !== "v1") throw new Error("Unsupported delivery cipher");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(iv, "base64"), additionalData: new TextEncoder().encode(orderId) }, await vault(env), Buffer.from(encrypted, "base64"));
  return new TextDecoder().decode(plain);
}
export async function shopAdmin(env: Env, owner: string) {
  const db = await ensureShop(env);
  if (!await db.prepare("SELECT user_id FROM membership_admins WHERE user_id=?").bind(owner).first()) throw new HttpError(403, "仅售码管理员可操作。");
  return db;
}
async function acceptingOrders(env: Env, now: number) {
  if (freeAccessEnabled(env)) return false;
  const db = await ensureShop(env);
  const setting = await db.prepare("SELECT value FROM membership_settings WHERE key='shop_open'").first<{ value: string }>();
  return membershipEnabled(env) && !membershipLaunchPending(env, now) && setting?.value === "1" && env.SHOP_ENABLED === "true" && !!env.SHOP_PAYMENTS && env.SHOP_PAYMENTS.environment === "live" && /^[a-f0-9]{64}$/i.test(env.SHOP_VAULT_KEY || "");
}
export async function createShopOrder(env: Env, owner: string, planId: string, requestKey: string, now = Date.now()) {
  if (freeAccessEnabled(env)) throw freeAccessError();
  const plan = shopPlans.find(p => p.id === planId);
  if (!plan || !/^[a-f0-9-]{36}$/i.test(requestKey)) throw new HttpError(400, "订单参数不正确，请重试。");
  const db = await ensureShop(env);
  const existing = await db.prepare("SELECT * FROM shop_orders WHERE user_id=? AND request_key=?").bind(owner, requestKey).first<ShopOrder>();
  if (existing) {
    if (existing.plan !== planId) throw new HttpError(409, "请重新选择卡种后下单。");
    return existing;
  }
  if (!await acceptingOrders(env, now)) throw new HttpError(503, "会员商店暂未开售，请稍后再来。");
  const id = "YY" + crypto.randomUUID().replaceAll("-", "").toUpperCase();
  await db.prepare("INSERT OR IGNORE INTO shop_orders(id,user_id,request_key,plan,days,amount_fen,environment,created_at,expires_at) SELECT ?,?,?,?,?,?,'live',?,? WHERE (SELECT COUNT(*) FROM shop_orders WHERE user_id=? AND status='pending' AND expires_at>?)<3")
    .bind(id, owner, requestKey, plan.id, plan.days, plan.amountFen, now, now + 15 * 60000, owner, now).run();
  const order = await db.prepare("SELECT * FROM shop_orders WHERE user_id=? AND request_key=?").bind(owner, requestKey).first<ShopOrder>();
  if (!order) throw new HttpError(429, "已有待支付订单，请先查看我的订单。");
  return order;
}

/** Only call with a server-verified provider receipt. The complete issue operation is one transaction. */
export async function fulfillShopOrder(env: Env, receipt: PaymentReceipt, now = Date.now()) {
  if (receipt.state !== "paid") return;
  if (receipt.environment !== "live" || env.SHOP_PAYMENTS?.environment !== "live") throw new HttpError(400, "测试支付不能发放正式会员卡。");
  const db = await ensureShop(env);
  const order = await db.prepare("SELECT * FROM shop_orders WHERE id=? AND environment='live'").bind(receipt.orderId).first<ShopOrder>();
  if (!order || receipt.amountFen !== order.amount_fen || !/^\d{8,64}$/.test(receipt.tradeId)) throw new HttpError(400, "支付通知与订单不匹配。");
  if (freeAccessEnabled(env)) {
    // Payments on pre-existing orders still need an authenticated, idempotent
    // accounting trail. Free access never issues another card or changes VIP time.
    await db.batch([
      db.prepare("INSERT INTO shop_payments(order_id,trade_id,amount_fen,created_at) VALUES(?,?,?,?) ON CONFLICT(order_id) DO NOTHING").bind(order.id, receipt.tradeId, receipt.amountFen, now),
      db.prepare("UPDATE shop_orders SET paid_at=COALESCE(paid_at,?) WHERE id=? AND EXISTS(SELECT 1 FROM shop_payments WHERE order_id=? AND trade_id=? AND amount_fen=?)").bind(now, order.id, order.id, receipt.tradeId, receipt.amountFen),
    ]);
    const payment = await db.prepare("SELECT trade_id FROM shop_payments WHERE order_id=?").bind(order.id).first<{ trade_id: string }>();
    if (payment?.trade_id !== receipt.tradeId) throw new HttpError(409, "订单支付流水冲突，请联系管理员核对。");
    return;
  }
  const raw = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex").toUpperCase();
  const code = "YY-" + raw.match(/.{8}/g)!.join("-");
  const hash = await digest(raw), encrypted = await encryptCode(env, order.id, code), batch = "shop:" + order.id;
  const paid = "EXISTS(SELECT 1 FROM shop_payments WHERE order_id=? AND trade_id=? AND amount_fen=?)";
  await db.batch([
    db.prepare("INSERT INTO shop_payments(order_id,trade_id,amount_fen,created_at) VALUES(?,?,?,?) ON CONFLICT(order_id) DO NOTHING").bind(order.id, receipt.tradeId, receipt.amountFen, now),
    db.prepare(`INSERT OR IGNORE INTO membership_batches(id,label,days,quantity,created_at,created_by) SELECT ?,?,days,1,?,user_id FROM shop_orders WHERE id=? AND ${paid}`).bind(batch, "自营商店 " + order.id, now, order.id, order.id, receipt.tradeId, receipt.amountFen),
    db.prepare(`INSERT INTO membership_cards(code_hash,batch_id,days,purpose,created_at) SELECT ?,?,days,'sale',? FROM shop_orders WHERE id=? AND ${paid} AND NOT EXISTS(SELECT 1 FROM shop_deliveries WHERE order_id=?)`).bind(hash, batch, now, order.id, order.id, receipt.tradeId, receipt.amountFen, order.id),
    db.prepare("INSERT INTO shop_deliveries(order_id,code_hash,encrypted_code,created_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM membership_cards WHERE code_hash=?)").bind(order.id, hash, encrypted, now, hash),
    db.prepare("UPDATE shop_orders SET status='fulfilled',paid_at=COALESCE(paid_at,?) WHERE id=? AND EXISTS(SELECT 1 FROM shop_deliveries WHERE order_id=shop_orders.id)").bind(now, order.id),
  ]);
  const payment = await db.prepare("SELECT trade_id FROM shop_payments WHERE order_id=?").bind(order.id).first<{ trade_id: string }>();
  if (payment?.trade_id !== receipt.tradeId) throw new HttpError(409, "订单支付流水冲突，请联系管理员核对。");
}

async function orderView(env: Env, order: ShopOrder, reveal: boolean) {
  const db = await ensureShop(env);
  const delivery = await db.prepare("SELECT d.encrypted_code,d.created_at,c.redeemed_at,c.status FROM shop_deliveries d JOIN membership_cards c ON c.code_hash=d.code_hash WHERE d.order_id=?").bind(order.id).first<{ encrypted_code: string; created_at: number; redeemed_at: number | null; status: string }>();
  return { id: order.id, plan: order.plan, days: order.days, amountFen: order.amount_fen, status: order.status, createdAt: order.created_at, expiresAt: order.expires_at, paidAt: order.paid_at,
    delivery: delivery ? { code: reveal ? await decryptCode(env, order.id, delivery.encrypted_code) : undefined, deliveredAt: delivery.created_at, redeemedAt: delivery.redeemed_at, revoked: delivery.status === "revoked" } : null };
}

export async function cardShopRoute(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url), path = url.pathname;
  if (!path.startsWith("/api/shop")) return null;
  if (freeAccessEnabled(env)) {
    if (path === "/api/shop" && request.method === "GET") return json({
      freeAccess: true, plans: [], open: false,
      launchAt: 0, launchDeferred: false, launchPending: false, user: null, admin: false,
    });
    if (request.method === "POST" && (path === "/api/shop/orders" || path === "/api/shop/admin/open" || /^\/api\/shop\/orders\/[^/]+\/checkout$/.test(path)))
      throw freeAccessError();
  }
  const db = await ensureShop(env);
  if (path === "/api/shop/alipay/notify" && request.method === "POST") {
    if (!env.SHOP_PAYMENTS) return new Response("failure", { status: 503 });
    try {
      const receipt = await env.SHOP_PAYMENTS.notification(request);
      await fulfillShopOrder(env, receipt);
      return new Response("success", { headers: { "Cache-Control": "no-store" } });
    } catch { return new Response("failure", { status: 400, headers: { "Cache-Control": "no-store" } }); }
  }
  const user = await currentUser(request, env);
  if (path === "/api/shop" && request.method === "GET") {
    const admin = user ? !!await db.prepare("SELECT user_id FROM membership_admins WHERE user_id=?").bind(user.id).first() : false;
    return json({ plans: shopPlans, open: await acceptingOrders(env, Date.now()), launchAt: membershipLaunchAt(env), launchDeferred: membershipLaunchDeferred(env), launchPending: membershipLaunchPending(env), user, admin });
  }
  if (!user) await requireUser(request, env);
  const owner = user!.id;
  if (request.method === "POST") assertOrigin(request);
  if (path === "/api/shop/orders" && request.method === "GET") {
    const orders = (await db.prepare("SELECT * FROM shop_orders WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 50").bind(owner).all<ShopOrder>()).results;
    return json({ orders: await Promise.all(orders.map(o => orderView(env, o, true))) });
  }
  if (path === "/api/shop/orders" && request.method === "POST") {
    await rateLimit({ ...env, DB: env.AUTH_DB || env.DB }, "shop-create:" + owner, 10, 10 * 60000);
    const data = await body(request, 1000);
    return json(await orderView(env, await createShopOrder(env, owner, data.plan, data.requestKey), true));
  }
  const match = path.match(/^\/api\/shop\/orders\/(YY[A-F0-9]{32})\/(checkout|sync)$/);
  if (match && request.method === "POST") {
    const order = await db.prepare("SELECT * FROM shop_orders WHERE id=? AND user_id=?").bind(match[1], owner).first<ShopOrder>();
    if (!order) throw new HttpError(404, "订单不存在。");
    if (order.status === "fulfilled") return json(await orderView(env, order, true));
    if (!env.SHOP_PAYMENTS) throw new HttpError(503, "支付渠道暂未接通。");
    if (match[2] === "sync") {
      await rateLimit({ ...env, DB: env.AUTH_DB || env.DB }, "shop-sync:" + owner, 12, 60000);
      const receipt = await env.SHOP_PAYMENTS.query(order);
      if (receipt) await fulfillShopOrder(env, receipt);
      return json(await orderView(env, (await db.prepare("SELECT * FROM shop_orders WHERE id=?").bind(order.id).first<ShopOrder>())!, true));
    }
    if (order.expires_at <= Date.now()) throw new HttpError(409, "订单已超时，请重新下单；如已付款，请点击核对支付状态。");
    if (!await acceptingOrders(env, Date.now())) throw new HttpError(503, "会员商店暂未开售。");
    await rateLimit({ ...env, DB: env.AUTH_DB || env.DB }, "shop-checkout:" + owner, 10, 60000);
    const data = await body(request, 1000);
    return json({ checkoutUrl: await env.SHOP_PAYMENTS.checkout(order, data.mobile === true) });
  }
  if (path.startsWith("/api/shop/admin")) {
    await shopAdmin(env, owner);
    if (path === "/api/shop/admin" && request.method === "GET") {
      const orders = (await db.prepare("SELECT o.*,u.email,u.name FROM shop_orders o JOIN users u ON u.id=o.user_id ORDER BY o.created_at DESC,o.id DESC LIMIT 100").all<ShopOrder & { email: string; name: string }>()).results;
      const totals = await db.prepare("SELECT COUNT(*) AS orders,COALESCE(SUM(CASE WHEN status='fulfilled' THEN 1 ELSE 0 END),0) AS delivered,COALESCE(SUM(CASE WHEN status='fulfilled' THEN amount_fen ELSE 0 END),0) AS revenueFen FROM shop_orders").first();
      return json({ ready: !freeAccessEnabled(env) && env.SHOP_ENABLED === "true" && !!env.SHOP_PAYMENTS && env.SHOP_PAYMENTS.environment === "live" && /^[a-f0-9]{64}$/i.test(env.SHOP_VAULT_KEY || ""), paymentConfigured: !!env.SHOP_PAYMENTS, environment: env.SHOP_PAYMENTS?.environment || "none", vaultConfigured: /^[a-f0-9]{64}$/i.test(env.SHOP_VAULT_KEY || ""), open: await acceptingOrders(env, Date.now()), totals, orders: await Promise.all(orders.map(async order => ({ ...await orderView(env, order, false), email: order.email, name: order.name }))) });
    }
    if (path === "/api/shop/admin/open" && request.method === "POST") {
      const data = await body(request, 1000);
      if (typeof data.open !== "boolean") throw new HttpError(400, "请选择开售或暂停。");
      if (data.open && membershipLaunchPending(env)) throw new HttpError(409, membershipLaunchDeferred(env) ? "订阅制上线时间推迟，具体时间另行通知。" : "会员尚未上线，具体时间请查看会员中心。");
      if (data.open && (env.SHOP_ENABLED !== "true" || !env.SHOP_PAYMENTS || env.SHOP_PAYMENTS.environment !== "live" || !/^[a-f0-9]{64}$/i.test(env.SHOP_VAULT_KEY || ""))) throw new HttpError(409, "请先完成正式支付接口和卡密加密配置。");
      await db.batch([
        db.prepare("INSERT INTO membership_settings(key,value) VALUES('shop_open',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(data.open ? "1" : "0"),
        db.prepare("INSERT INTO shop_audit(id,actor,action,target,created_at) VALUES(?,?,?,?,?)").bind(crypto.randomUUID(), owner, data.open ? "open" : "pause", "shop", Date.now()),
      ]);
      return json({ ok: true });
    }
  }
  throw new HttpError(404, "商店接口不存在。");
}
