import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { HttpError } from "../src/lib/http";
import type { PaymentReceipt, ShopOrder, ShopPayments } from "../worker/card-shop";

export type AlipayConfig = { appId: string; sellerId: string; privateKey: string; alipayPublicKey: string; siteOrigin: string; environment?: "live" | "sandbox"; mobileEnabled?: boolean };
const canonical = (params: Record<string, string>, notification = false) => Object.keys(params).filter(k => k !== "sign" && (!notification || k !== "sign_type") && params[k] !== "").sort().map(k => `${k}=${params[k]}`).join("&");
export function amountFen(value: unknown) {
  if (typeof value !== "string" || !/^\d{1,7}(\.\d{1,2})?$/.test(value)) throw new HttpError(400, "支付金额格式无效。");
  const [yuan, fraction = ""] = value.split(".");
  return Number(yuan) * 100 + Number(fraction.padEnd(2, "0"));
}
async function limitedText(message: Request | Response, max = 65536) {
  const reader = message.body?.getReader();
  if (!reader) throw new Error("Empty payment body");
  const chunks: Uint8Array[] = []; let bytes = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.length;
    if (bytes > max) { await reader.cancel(); throw new Error("Payment body exceeds limit"); }
    chunks.push(part.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Preserve the exact JSON bytes signed by Alipay; JSON reserialization can change them. */
export function signedJsonFields(text: string) {
  const fields = new Map<string, string>(); let i = 0;
  const whitespace = () => { while (/\s/.test(text[i] || "") && i < text.length) i++; };
  const stringEnd = () => { i++; for (; i < text.length; i++) { if (text[i] === "\\") i++; else if (text[i] === '"') { i++; return; } } throw new Error("Unterminated JSON"); };
  whitespace(); if (text[i++] !== "{") throw new Error("Invalid response JSON");
  for (;;) {
    whitespace(); if (text[i] === "}") { i++; break; }
    const keyStart = i; if (text[i] !== '"') throw new Error("Invalid response key"); stringEnd();
    const key = JSON.parse(text.slice(keyStart, i)) as string;
    if (fields.has(key)) throw new Error("Duplicate response key");
    whitespace(); if (text[i++] !== ":") throw new Error("Invalid response separator"); whitespace();
    const start = i;
    if (text[i] === '"') stringEnd();
    else if (text[i] === "{" || text[i] === "[") {
      const stack: string[] = [];
      for (; i < text.length; i++) {
        if (text[i] === '"') { stringEnd(); i--; }
        else if (text[i] === "{" || text[i] === "[") stack.push(text[i]);
        else if (text[i] === "}" || text[i] === "]") {
          if (stack.pop() !== (text[i] === "}" ? "{" : "[")) throw new Error("Invalid response nesting");
          if (!stack.length) { i++; break; }
        }
      }
      if (stack.length) throw new Error("Truncated response");
    } else { while (i < text.length && !/[},\s]/.test(text[i])) i++; }
    fields.set(key, text.slice(start, i));
    whitespace(); if (text[i] === "}") { i++; break; }
    if (text[i++] !== ",") throw new Error("Invalid response delimiter");
  }
  whitespace(); if (i !== text.length) throw new Error("Trailing response content");
  JSON.parse(text);
  return fields;
}

export function alipayPayments(config: AlipayConfig, transport: typeof fetch = fetch): ShopPayments {
  if (!/^\d{16}$/.test(config.appId) || !/^2088\d{12}$/.test(config.sellerId)) throw new Error("Invalid Alipay merchant configuration");
  const origin = new URL(config.siteOrigin);
  if (origin.protocol !== "https:" || origin.origin + "/" !== origin.href) throw new Error("Payments require an HTTPS site origin");
  const privateKey = createPrivateKey(config.privateKey), publicKey = createPublicKey(config.alipayPublicKey);
  if (privateKey.asymmetricKeyType !== "rsa" || publicKey.asymmetricKeyType !== "rsa" || (privateKey.asymmetricKeyDetails?.modulusLength || 0) < 2048 || (publicKey.asymmetricKeyDetails?.modulusLength || 0) < 2048) throw new Error("Alipay requires RSA keys of at least 2048 bits");
  const environment = config.environment || "live";
  if (!["live", "sandbox"].includes(environment)) throw new Error("Invalid payment environment");
  const gateway = environment === "live" ? "https://openapi.alipay.com/gateway.do" : "https://openapi-sandbox.dl.alipaydev.com/gateway.do";
  function params(method: string, content: Record<string, unknown>) {
    const timestamp = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");
    return { app_id: config.appId, method, format: "JSON", charset: "utf-8", sign_type: "RSA2", timestamp, version: "1.0", biz_content: JSON.stringify(content) };
  }
  function signed(value: Record<string, string>) { return new URLSearchParams({ ...value, sign: sign("RSA-SHA256", Buffer.from(canonical(value)), privateKey).toString("base64") }); }
  function receipt(data: Record<string, string>): PaymentReceipt {
    if (data.seller_id !== config.sellerId) throw new Error("Unexpected payment merchant");
    if (!["TRADE_SUCCESS", "TRADE_FINISHED", "WAIT_BUYER_PAY", "TRADE_CLOSED"].includes(data.trade_status)) throw new Error("Unknown payment state");
    if (!/^YY[A-F0-9]{32}$/.test(data.out_trade_no) || !/^\d{8,64}$/.test(data.trade_no)) throw new Error("Invalid payment identifiers");
    return { orderId: data.out_trade_no, tradeId: data.trade_no, amountFen: amountFen(data.total_amount), state: ["TRADE_SUCCESS", "TRADE_FINISHED"].includes(data.trade_status) ? "paid" : data.trade_status === "TRADE_CLOSED" ? "closed" : "pending", environment };
  }
  return {
    environment,
    async checkout(order, mobile) {
      const useMobile = mobile && config.mobileEnabled === true;
      const content = { out_trade_no: order.id, subject: `译洋 / 莎试笔雅 · ${order.days === 7 ? "周" : "月"}会员卡`, product_code: useMobile ? "QUICK_WAP_WAY" : "FAST_INSTANT_TRADE_PAY", total_amount: (order.amount_fen / 100).toFixed(2), time_expire: new Date(order.expires_at + 8 * 3600000).toISOString().slice(0, 19).replace("T", " "), ...(useMobile ? { quit_url: origin.origin + "/shop" } : {}) };
      const values = { ...params(useMobile ? "alipay.trade.wap.pay" : "alipay.trade.page.pay", content), notify_url: origin.origin + "/api/shop/alipay/notify", return_url: origin.origin + "/shop?order=" + order.id };
      return gateway + "?" + signed(values).toString();
    },
    async notification(request) {
      if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/x-www-form-urlencoded")) throw new Error("Unexpected notification content type");
      const form = new URLSearchParams(await limitedText(request));
      const data: Record<string, string> = {};
      for (const [key, value] of form) { if (Object.hasOwn(data, key)) throw new Error("Duplicate notification field"); Object.defineProperty(data, key, { value, enumerable: true }); }
      if (data.sign_type !== "RSA2" || !data.sign || data.sign.length > 2048 || !verify("RSA-SHA256", Buffer.from(canonical(data, true)), publicKey, Buffer.from(data.sign, "base64"))) throw new Error("Invalid payment signature");
      if (data.app_id !== config.appId) throw new Error("Unexpected payment app");
      return receipt(data);
    },
    async query(order) {
      const response = await transport(gateway, { method: "POST", body: signed(params("alipay.trade.query", { out_trade_no: order.id })), signal: AbortSignal.timeout(10000), redirect: "error" });
      if (!response.ok) throw new HttpError(502, "支付状态暂时无法查询，请稍后重试。");
      const fields = signedJsonFields(await limitedText(response));
      const raw = fields.get("alipay_trade_query_response"), signature = fields.get("sign");
      if (!raw || !signature || !verify("RSA-SHA256", Buffer.from(raw), publicKey, Buffer.from(JSON.parse(signature), "base64"))) throw new Error("Invalid query response signature");
      const data = JSON.parse(raw);
      if (data.code !== "10000") {
        if (data.sub_code === "ACQ.TRADE_NOT_EXIST") return null;
        throw new HttpError(502, "支付状态暂时无法查询，请稍后重试。");
      }
      // alipay.trade.query has no seller_id; the signed response is bound to our signed merchant request and exact local order.
      if (data.out_trade_no !== order.id || amountFen(data.total_amount) !== order.amount_fen) throw new Error("Payment query order mismatch");
      return receipt({ ...data, seller_id: config.sellerId });
    },
  };
}

export function loadShopConfiguration(siteOrigin: string) {
  const path = process.env.SHOP_CONFIG_FILE;
  if (!path) return {};
  const config = JSON.parse(readFileSync(path, "utf8"));
  if (typeof config.vaultKey !== "string" || !/^[a-f0-9]{64}$/i.test(config.vaultKey)) throw new Error("Invalid shop vault key; never regenerate an existing key");
  return { SHOP_ENABLED: config.enabled === true ? "true" : "false", SHOP_VAULT_KEY: config.vaultKey,
    ...(config.alipay ? { SHOP_PAYMENTS: alipayPayments({ ...config.alipay, siteOrigin }) } : {}),
  };
}
