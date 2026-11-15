import type { D1Database } from "@cloudflare/workers-types";
import { HttpError, assertOrigin, body } from "../src/lib/http";
import { currentUser, digest, rateLimit, requireUser } from "./auth";
import type { Env } from "./types";
import { adminPromotionReport, assertPromotionCardEligible, promotionCardRedemptionCondition, promotionForInviter, promotionForMember, promotionShareRoute } from "./promotion";

export const MEMBER_DAYS = 30;
export const MEMBER_PRICE = 990;
export const WEEK_MEMBER_PRICE = 390;
const DAY = 86400_000;
export const EARLY_MEMBER_CUTOFF = "2026-11-02T00:00:00+08:00";
const EARLY_MEMBER_PREFIX = "early-member:20261102:";
type EarlyMemberMode = "total";
const schemas = new WeakMap<D1Database, Promise<unknown>>();
const identity = (env: Env) => env.AUTH_DB || env.DB;
export const freeAccessEnabled = (env: Env) => env.FREE_ACCESS_ENABLED === "true";
export const membershipEnabled = (env: Env) => !freeAccessEnabled(env) && env.MEMBERSHIP_ENABLED === "true";
const freeAccessMessage = "会员制度已取消，现已免费开放，无需购买或兑换。";
function assertMembershipSalesAllowed(env: Env) {
  if (freeAccessEnabled(env)) throw new HttpError(410, freeAccessMessage, "FREE_ACCESS_ENABLED");
}
export const memberDay = (now = Date.now()) => new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
const site = (env: Env) => env.MEMBERSHIP_SITE || "ielts";
const referralCode = () => crypto.randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
type Account = { user_id: string; expires_at: number; trial_granted: number; referral_code: string };

export async function ensureMembership(env: Env) {
  const db = identity(env);
  if (!schemas.has(db)) {
    const sql = [
      "CREATE TABLE IF NOT EXISTS membership_accounts(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL DEFAULT 0,trial_granted INTEGER NOT NULL DEFAULT 0 CHECK(trial_granted>=0),referral_code TEXT NOT NULL UNIQUE)",
      "CREATE TABLE IF NOT EXISTS membership_permanent(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,granted_at INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS membership_referral_campaigns(inviter_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,referral_code TEXT NOT NULL UNIQUE,days INTEGER NOT NULL CHECK(days BETWEEN 1 AND 365),created_at INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS membership_referral_permanent_campaigns(inviter_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,referral_code TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS membership_referral_permanent_grants(invitee_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,inviter_id TEXT NOT NULL REFERENCES users(id),source TEXT NOT NULL CHECK(source IN ('registration','history')),granted_at INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS membership_admins(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE)",
      "CREATE TABLE IF NOT EXISTS membership_events(event_key TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,days INTEGER NOT NULL CHECK(days>0),reason TEXT NOT NULL,created_at INTEGER NOT NULL,applied_at INTEGER)",
      "CREATE INDEX IF NOT EXISTS membership_events_owner ON membership_events(user_id,created_at)",
      "CREATE TABLE IF NOT EXISTS membership_batches(id TEXT PRIMARY KEY,label TEXT NOT NULL,days INTEGER NOT NULL,quantity INTEGER NOT NULL,created_at INTEGER NOT NULL,created_by TEXT NOT NULL REFERENCES users(id))",
      "CREATE TABLE IF NOT EXISTS membership_cards(code_hash TEXT PRIMARY KEY,batch_id TEXT NOT NULL REFERENCES membership_batches(id),days INTEGER NOT NULL CHECK(days>0),purpose TEXT NOT NULL DEFAULT 'sale' CHECK(purpose IN ('sale','gift')),status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),created_at INTEGER NOT NULL,redeemed_by TEXT REFERENCES users(id),redeemed_at INTEGER,redemption_id TEXT)",
      "CREATE INDEX IF NOT EXISTS membership_cards_batch ON membership_cards(batch_id)",
      "CREATE TABLE IF NOT EXISTS membership_invites(invitee_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,inviter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,created_at INTEGER NOT NULL,CHECK(invitee_id<>inviter_id))",
      "CREATE TABLE IF NOT EXISTS membership_first_payments(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,card_hash TEXT NOT NULL REFERENCES membership_cards(code_hash),created_at INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS membership_usage(site TEXT NOT NULL,request_key TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,review_id TEXT NOT NULL,source TEXT NOT NULL CHECK(source IN ('daily','trial','member')),day TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('reserved','completed','released')),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(site,request_key))",
      "CREATE UNIQUE INDEX IF NOT EXISTS membership_daily_use ON membership_usage(user_id,day) WHERE source='daily' AND status IN ('reserved','completed')",
      "CREATE INDEX IF NOT EXISTS membership_usage_owner ON membership_usage(user_id,status,source)",
      "CREATE TABLE IF NOT EXISTS membership_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS membership_early_gifts(event_key TEXT PRIMARY KEY,user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,mode TEXT NOT NULL CHECK(mode='total'),days INTEGER NOT NULL CHECK(days BETWEEN 0 AND 5),outcome TEXT NOT NULL DEFAULT 'pending' CHECK(outcome IN ('pending','credited','permanent','covered')),created_at INTEGER NOT NULL,applied_at INTEGER)",
    ];
    const init = db.batch(sql.map(s => db.prepare(s))).catch(error => { schemas.delete(db); throw error; });
    schemas.set(db, init);
  }
  await schemas.get(db);
  return db;
}

export function membershipLaunchAt(env: Env) {
  if (!env.MEMBERSHIP_LAUNCH_AT) return 0;
  const value = Date.parse(env.MEMBERSHIP_LAUNCH_AT);
  if (!Number.isFinite(value)) throw new Error("Invalid membership launch time");
  return value;
}
export const membershipLaunchDeferred = (env: Env) => env.MEMBERSHIP_LAUNCH_DEFERRED === "true";
export const membershipLaunchPending = (env: Env, now = Date.now()) => membershipLaunchDeferred(env) || now < membershipLaunchAt(env);
export async function membershipAccessEnabled(env: Env, now = Date.now()) {
  if (freeAccessEnabled(env)) return false;
  if (membershipLaunchPending(env, now)) return false;
  if (env.MEMBERSHIP_REQUIRE_READY !== "true") return true;
  const db = await ensureMembership(env);
  const row = await db.prepare("SELECT value FROM membership_settings WHERE key='sales_ready'").first<{value:string}>();
  return row?.value === "1";
}
export async function membershipReviewMode(env: Env, owner: string, now = Date.now()): Promise<"free" | "legacy" | "member" | "metered"> {
  if (freeAccessEnabled(env)) return "free";
  if (!membershipEnabled(env)) return "legacy";
  if (membershipLaunchPending(env, now)) return "legacy";
  if ((await activeMembershipIds(env, [owner], now)).has(owner)) return "member";
  return await membershipAccessEnabled(env, now) ? "metered" : "legacy";
}

/** Public callers receive only current VIP membership, never private expiry or referral data. */
export async function activeMembershipIds(env: Env, owners: string[], now = Date.now()): Promise<Set<string>> {
  const active = new Set<string>();
  if (!membershipEnabled(env) || !owners.length) return active;
  const db = await ensureMembership(env), ids = [...new Set(owners)];
  for (let offset = 0; offset < ids.length; offset += 80) {
    const batch = ids.slice(offset, offset + 80);
    const rows = (await db.prepare(`SELECT u.id AS user_id FROM users u LEFT JOIN membership_accounts a ON a.user_id=u.id LEFT JOIN membership_permanent p ON p.user_id=u.id WHERE u.id IN (${batch.map(() => "?").join(",")}) AND (p.user_id IS NOT NULL OR a.expires_at>?)`).bind(...batch, now).all<{user_id:string}>()).results;
    for (const row of rows) active.add(row.user_id);
  }
  return active;
}

function accountStatement(db: D1Database, owner: string, trials = 0) {
  return db.prepare("INSERT OR IGNORE INTO membership_accounts(user_id,trial_granted,referral_code) VALUES(?,?,?)").bind(owner, trials, referralCode());
}
async function earlyMemberMode(db: D1Database): Promise<EarlyMemberMode | null> {
  const row = await db.prepare("SELECT value FROM membership_settings WHERE key='early_member_gift_mode'").first<{value:string}>();
  return row?.value === "total" ? row.value : null;
}
function earlyMemberStatements(db: D1Database, owner: string, mode: EarlyMemberMode, now: number, launchAt: number) {
  const key = EARLY_MEMBER_PREFIX + owner;
  const permanent = "EXISTS(SELECT 1 FROM membership_permanent p WHERE p.user_id=u.id)";
  const special = "EXISTS(SELECT 1 FROM membership_events e WHERE e.user_id=u.id AND e.reason='registration-invite' AND e.applied_at IS NOT NULL)";
  const welcome = "COALESCE((SELECT days FROM membership_events e WHERE e.event_key='registration-welcome:'||u.id AND e.applied_at IS NOT NULL),0)";
  return [
    accountStatement(db, owner),
    db.prepare(`INSERT OR IGNORE INTO membership_early_gifts(event_key,user_id,mode,days,created_at)
      SELECT ?,u.id,?,CASE WHEN ${permanent} THEN 0 WHEN ${special} THEN 0 ELSE MAX(0,5-${welcome}) END,?
      FROM users u WHERE u.id=? AND julianday(u.created_at)<julianday(?)`).bind(key, mode, now, owner, EARLY_MEMBER_CUTOFF),
    db.prepare("UPDATE membership_accounts SET expires_at=MAX(expires_at,?)+(SELECT days FROM membership_early_gifts WHERE event_key=?)*? WHERE user_id=? AND NOT EXISTS(SELECT 1 FROM membership_permanent WHERE user_id=?) AND EXISTS(SELECT 1 FROM membership_early_gifts WHERE event_key=? AND user_id=? AND applied_at IS NULL AND days>0)").bind(Math.max(now, launchAt, Date.parse(EARLY_MEMBER_CUTOFF)), key, DAY, owner, owner, key, owner),
    db.prepare("INSERT OR IGNORE INTO membership_events(event_key,user_id,days,reason,created_at,applied_at) SELECT event_key,user_id,days,'early-member',?,? FROM membership_early_gifts WHERE event_key=? AND applied_at IS NULL AND days>0").bind(now, now, key),
    db.prepare("UPDATE membership_early_gifts SET outcome=CASE WHEN EXISTS(SELECT 1 FROM membership_permanent p WHERE p.user_id=membership_early_gifts.user_id) THEN 'permanent' WHEN days=0 THEN 'covered' ELSE 'credited' END,applied_at=? WHERE event_key=? AND applied_at IS NULL").bind(now, key),
  ];
}
/** Bounded repair covers old accounts as well as registrations while deployment switches sites. */
export async function reconcileEarlyMemberGifts(env: Env, now = Date.now(), limit = 200) {
  if (!membershipEnabled(env)) return;
  const db = await ensureMembership(env), mode = await earlyMemberMode(db);
  if (!mode) return;
  const owners = (await db.prepare("SELECT u.id FROM users u LEFT JOIN membership_early_gifts g ON g.user_id=u.id WHERE julianday(u.created_at)<julianday(?) AND (g.user_id IS NULL OR g.applied_at IS NULL) ORDER BY u.created_at,u.id LIMIT ?").bind(EARLY_MEMBER_CUTOFF, Math.max(1, Math.min(200, Math.trunc(limit)))).all<{id:string}>()).results;
  if (owners.length) await db.batch(owners.flatMap(row => earlyMemberStatements(db, row.id, mode, now, membershipLaunchAt(env))));
}
/** Included in the same identity transaction as the new users row. */
export async function registrationMembershipStatements(env: Env, owner: string, referral: string | undefined, now = Date.now()) {
  if (!membershipEnabled(env)) return [];
  const db = await ensureMembership(env);
  const code = (referral || "").trim().toUpperCase();
  const inviter = code ? await db.prepare("SELECT user_id FROM membership_accounts WHERE referral_code=?").bind(code).first<{ user_id: string }>() : null;
  if (code && !inviter) throw new HttpError(400, "好友邀请码无效，请核对后重试。");
  if (inviter?.user_id === owner) throw new HttpError(400, "不能使用自己的邀请码。");
  const statements = [accountStatement(db, owner)];
  // Registration gifts use their own per-invitee key; they never create a first-payment
  // record or consume the separate invite-paid:<invitee> three-day purchase reward.
  if (inviter) statements.push(
    db.prepare("INSERT OR IGNORE INTO membership_invites(invitee_id,inviter_id,created_at) SELECT ?,user_id,? FROM membership_accounts WHERE user_id=? AND referral_code=? AND user_id<>?").bind(owner, now, inviter.user_id, code, owner),
    // Permanent campaigns take priority, and an existing registered account's
    // historical gift is never upgraded implicitly by replaying this helper.
    db.prepare("INSERT OR IGNORE INTO membership_referral_permanent_grants(invitee_id,inviter_id,source,granted_at) SELECT i.invitee_id,i.inviter_id,'registration',? FROM membership_invites i JOIN membership_referral_permanent_campaigns c ON c.inviter_id=i.inviter_id JOIN membership_accounts a ON a.user_id=c.inviter_id AND a.referral_code=c.referral_code JOIN users u ON u.id=i.invitee_id AND julianday(u.created_at)>=julianday(c.created_at/1000.0,'unixepoch') WHERE i.invitee_id=? AND c.referral_code=? AND NOT EXISTS(SELECT 1 FROM membership_events e WHERE e.user_id=i.invitee_id AND e.reason IN ('registration-welcome','registration-invite') AND e.applied_at IS NOT NULL)").bind(now, owner, code),
    db.prepare("INSERT OR IGNORE INTO membership_permanent(user_id,granted_at) SELECT invitee_id,granted_at FROM membership_referral_permanent_grants WHERE invitee_id=?").bind(owner),
    db.prepare("INSERT OR IGNORE INTO membership_events(event_key,user_id,days,reason,created_at) SELECT ?,i.invitee_id,c.days,'registration-invite',? FROM membership_invites i JOIN membership_referral_campaigns c ON c.inviter_id=i.inviter_id JOIN membership_accounts a ON a.user_id=c.inviter_id AND a.referral_code=c.referral_code WHERE i.invitee_id=? AND c.referral_code=? AND NOT EXISTS(SELECT 1 FROM membership_events WHERE event_key=?) AND NOT EXISTS(SELECT 1 FROM membership_permanent WHERE user_id=?)").bind("registration-invite:" + owner, now, owner, code, "registration-welcome:" + owner, owner),
    db.prepare("UPDATE membership_accounts SET expires_at=MAX(expires_at,?)+(SELECT days FROM membership_events WHERE event_key=?)*? WHERE user_id=? AND NOT EXISTS(SELECT 1 FROM membership_permanent WHERE user_id=?) AND EXISTS(SELECT 1 FROM membership_events WHERE event_key=? AND user_id=? AND applied_at IS NULL)").bind(Math.max(now, membershipLaunchAt(env)), "registration-invite:" + owner, DAY, owner, owner, "registration-invite:" + owner, owner),
    db.prepare("UPDATE membership_events SET applied_at=? WHERE event_key=? AND user_id=? AND applied_at IS NULL").bind(now, "registration-invite:" + owner, owner),
  );
  // Every other new account gets the standard one-day welcome gift. The two
  // registration event keys exclude one another, so a special invitation is 30,
  // never 30 + 1. New accounts receive no extra trial attempts; existing balances stay intact.
  const welcomeKey = "registration-welcome:" + owner;
  statements.push(
    db.prepare("INSERT OR IGNORE INTO membership_events(event_key,user_id,days,reason,created_at) SELECT ?,?,1,'registration-welcome',? WHERE NOT EXISTS(SELECT 1 FROM membership_events WHERE event_key=?) AND NOT EXISTS(SELECT 1 FROM membership_permanent WHERE user_id=?)").bind(welcomeKey, owner, now, "registration-invite:" + owner, owner),
    db.prepare("UPDATE membership_accounts SET expires_at=MAX(expires_at,?)+? WHERE user_id=? AND NOT EXISTS(SELECT 1 FROM membership_permanent WHERE user_id=?) AND EXISTS(SELECT 1 FROM membership_events WHERE event_key=? AND user_id=? AND applied_at IS NULL)").bind(Math.max(now, membershipLaunchAt(env)), DAY, owner, owner, welcomeKey, owner),
    db.prepare("UPDATE membership_events SET applied_at=? WHERE event_key=? AND user_id=? AND applied_at IS NULL").bind(now, welcomeKey, owner),
  );
  const earlyMode = await earlyMemberMode(db);
  if (earlyMode) statements.push(...earlyMemberStatements(db, owner, earlyMode, now, membershipLaunchAt(env)));
  return statements;
}

export async function reconcileMembershipUsage(env: Env, owner?: string, now = Date.now()) {
  if (!membershipEnabled(env)) return;
  const db = await ensureMembership(env);
  const pending = (await db.prepare("SELECT request_key,review_id,created_at FROM membership_usage WHERE site=? AND status='reserved'" + (owner ? " AND user_id=?" : "") + " LIMIT 200").bind(...(owner ? [site(env), owner] : [site(env)])).all<{ request_key: string; review_id: string; created_at: number }>()).results;
  for (const usage of pending) {
    const review = await env.DB.prepare("SELECT status FROM reviews WHERE id=?").bind(usage.review_id).first<{ status: string }>();
    const status = review?.status === "completed" ? "completed" : review?.status === "failed" || (!review && usage.created_at < now - 120_000) ? "released" : null;
    if (status) await db.prepare("UPDATE membership_usage SET status=?,updated_at=? WHERE site=? AND request_key=? AND status='reserved'").bind(status, now, site(env), usage.request_key).run();
  }
}

export async function reserveMembershipReview(env: Env, owner: string, requestKey: string, reviewId: string, now = Date.now()) {
  if (!membershipEnabled(env)) return;
  if (await membershipReviewMode(env, owner, now) === "legacy") return;
  const db = await ensureMembership(env);
  await db.batch([accountStatement(db, owner)]);
  // One conditional insert decides the allowance atomically across both sites.
  const daily = "NOT EXISTS(SELECT 1 FROM membership_usage d WHERE d.user_id=a.user_id AND d.day=? AND d.source='daily' AND d.status<>'released')";
  const remaining = "(SELECT COUNT(*) FROM membership_usage t WHERE t.user_id=a.user_id AND t.source='trial' AND t.status<>'released')<a.trial_granted";
  const member = "(a.expires_at>? OR EXISTS(SELECT 1 FROM membership_permanent p WHERE p.user_id=a.user_id))";
  const result = await db.prepare(`INSERT OR IGNORE INTO membership_usage(site,request_key,user_id,review_id,source,day,status,created_at,updated_at)
    SELECT ?,?,a.user_id,?,CASE WHEN ${member} THEN 'member' WHEN ${daily} THEN 'daily' ELSE 'trial' END,?,'reserved',?,?
    FROM membership_accounts a WHERE a.user_id=? AND (${member} OR ${daily} OR ${remaining})`)
    .bind(site(env), requestKey, reviewId, now, memberDay(now), memberDay(now), now, now, owner, now, memberDay(now)).run();
  if (!result.meta.changes) {
    const existing = await db.prepare("SELECT review_id,status FROM membership_usage WHERE site=? AND request_key=? AND user_id=?").bind(site(env), requestKey, owner).first<{ review_id: string; status: string }>();
    if (existing?.review_id === reviewId && existing.status !== "released") return;
    if (existing && existing.status !== "released") throw new HttpError(409, "同一篇作答正在处理，请稍候。", "REVIEW_PENDING");
    throw new HttpError(402, "今日免费批改和试用次数已用完，可开通会员继续批改。", "MEMBERSHIP_REQUIRED");
  }
}
export async function finishMembershipReview(env: Env, owner: string, reviewId: string, completed: boolean, now = Date.now()) {
  if (!membershipEnabled(env)) return;
  const db = await ensureMembership(env);
  await db.prepare("UPDATE membership_usage SET status=?,updated_at=? WHERE site=? AND user_id=? AND review_id=? AND status='reserved'").bind(completed ? "completed" : "released", now, site(env), owner, reviewId).run();
}

export async function membershipStatus(env: Env, owner?: string, now = Date.now()) {
  if (freeAccessEnabled(env)) return {
    enabled: false, accessEnabled: false, freeAccess: true,
    launchAt: 0, launchDeferred: false, launchPending: false,
    plan: null, plans: [], promotion: null, account: null,
  };
  const db = await ensureMembership(env);
  const accessEnabled = await membershipAccessEnabled(env, now);
  const launchAt = membershipLaunchAt(env), launchDeferred = membershipLaunchDeferred(env), launchPending = membershipLaunchPending(env, now);
  const buyUrl = env.MEMBERSHIP_BUY_URL || "https://catfk.com/shop/8VID2BZD";
  const links = (await db.prepare("SELECT key,value FROM membership_settings WHERE key IN ('week_buy_url','month_buy_url')").all<{key:string;value:string}>()).results;
  const link = (key: string) => {
    const value = links.find(row => row.key === key)?.value;
    try { const url = new URL(value || ""); if (url.protocol === "https:" && url.hostname === "catfk.com" && !url.username && !url.password && !url.port && /^\/(item|shop)\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) return url.href; } catch {}
    return buyUrl;
  };
  const plan = { price: MEMBER_PRICE / 100, days: MEMBER_DAYS, buyUrl: link("month_buy_url") };
  const plans = [{ id: "week", price: WEEK_MEMBER_PRICE / 100, days: 7, buyUrl: link("week_buy_url"), available: accessEnabled }, { id: "month", price: MEMBER_PRICE / 100, days: 30, buyUrl: link("month_buy_url"), available: accessEnabled }];
  if (!owner) return { enabled: membershipEnabled(env), accessEnabled, launchAt, launchDeferred, launchPending, plan, plans, account: null };
  await db.batch([accountStatement(db, owner)]);
  await reconcileMembershipUsage(env, owner, now);
  const account = (await db.prepare("SELECT * FROM membership_accounts WHERE user_id=?").bind(owner).first<Account>())!;
  const promotion = await promotionForMember(env, owner);
  const inviterPromotion = await promotionForInviter(env, owner);
  if (promotion) {
    for (const offer of plans) {
      const offerUrl = offer.id === "week" ? promotion.weekBuyUrl : promotion.monthBuyUrl;
      // Keep the base price/link for already-open older clients that cannot show a
      // coupon. New clients opt in to the separate discount quote and instructions.
      if (offerUrl) Object.assign(offer, { originalPrice: offer.price, discountPrice: Math.floor((Math.round(offer.price * 100) * promotion.discountBps + 5000) / 10000) / 100, discountBuyUrl: `/api/membership/promotion-checkout?plan=${offer.id}`, discountBps: promotion.discountBps });
    }
    Object.assign(plan, plans.find(value => value.id === "month"));
  }
  const permanent = !!await db.prepare("SELECT user_id FROM membership_permanent WHERE user_id=?").bind(owner).first();
  const referralOffer = await db.prepare("SELECT days FROM membership_referral_campaigns WHERE inviter_id=? AND referral_code=?").bind(owner, account.referral_code).first<{days:number}>();
  const referralOfferPermanent = !!await db.prepare("SELECT inviter_id FROM membership_referral_permanent_campaigns WHERE inviter_id=? AND referral_code=?").bind(owner, account.referral_code).first();
  const used = (await db.prepare("SELECT source,day,COUNT(*) AS n FROM membership_usage WHERE user_id=? AND status<>'released' GROUP BY source,day").bind(owner).all<{ source: string; day: string; n: number }>()).results;
  const trialUsed = used.filter(r => r.source === "trial").reduce((n, r) => n + Number(r.n), 0);
  const dailyUsed = used.some(r => r.source === "daily" && r.day === memberDay(now) && Number(r.n) > 0);
  const admin = !!await db.prepare("SELECT user_id FROM membership_admins WHERE user_id=?").bind(owner).first();
  const invites = await db.prepare("SELECT COUNT(*) AS n FROM membership_invites WHERE inviter_id=?").bind(owner).first<{ n: number }>();
  const rewardedInvites = await db.prepare("SELECT COUNT(*) AS n FROM membership_invites i JOIN membership_first_payments p ON p.user_id=i.invitee_id WHERE i.inviter_id=?").bind(owner).first<{ n: number }>();
  const events = (await db.prepare("SELECT days,reason,created_at FROM membership_events WHERE user_id=? AND applied_at IS NOT NULL ORDER BY created_at DESC,event_key DESC LIMIT 20").bind(owner).all<{ days: number; reason: string; created_at: number }>()).results;
  return { enabled: membershipEnabled(env), accessEnabled, launchAt, launchDeferred, launchPending, plan, plans, promotion: promotion ? { discountBps: promotion.discountBps, couponCode: promotion.couponCode, ready: !!promotion.weekBuyUrl && !!promotion.monthBuyUrl } : null, account: { active: permanent || account.expires_at > now, permanent, expiresAt: permanent ? null : account.expires_at || null, trialRemaining: Math.max(0, account.trial_granted - trialUsed), dailyRemaining: dailyUsed ? 0 : 1, referralCode: account.referral_code, referralOfferDays: referralOffer?.days || 0, referralOfferPermanent, inviterPromotion, invited: Number(invites?.n || 0), rewardedInvites: Number(rewardedInvites?.n || 0), admin, events } };
}

export async function redeemMembership(env: Env, owner: string, raw: string, now = Date.now()) {
  assertMembershipSalesAllowed(env);
  if (membershipLaunchDeferred(env)) throw new HttpError(503, "订阅制上线时间推迟，具体时间另行通知。");
  if (membershipLaunchPending(env, now)) throw new HttpError(503, "会员尚未上线，具体时间请查看会员中心。");
  const code = raw.trim().replace(/^YY[-\s]?/i, "").replace(/[\s-]/g, "").toUpperCase();
  if (!/^[A-F0-9]{32}$/.test(code)) throw new HttpError(400, "请填写完整的会员兑换码。");
  const hash = await digest(code), db = await ensureMembership(env), nonce = crypto.randomUUID();
  // Check before the redemption batch: rejecting permanent VIP leaves the card's
  // redemption fields and all card/first-payment/invitation events untouched.
  if (await db.prepare("SELECT user_id FROM membership_permanent WHERE user_id=?").bind(owner).first()) throw new HttpError(400, "你已拥有永久VIP，无需兑换会员卡。");
  await assertPromotionCardEligible(env, owner, hash);
  const key = "card:" + hash;
  await db.batch([
    accountStatement(db, owner),
    db.prepare(`UPDATE membership_cards SET redeemed_by=?,redeemed_at=?,redemption_id=? WHERE code_hash=? AND status='active' AND redeemed_at IS NULL AND ${promotionCardRedemptionCondition}`).bind(owner, now, nonce, hash, owner),
    db.prepare("INSERT OR IGNORE INTO membership_events(event_key,user_id,days,reason,created_at) SELECT ?,?,days,'card',? FROM membership_cards WHERE code_hash=? AND redeemed_by=? AND redemption_id=?").bind(key, owner, now, hash, owner, nonce),
    db.prepare("UPDATE membership_accounts SET expires_at=MAX(expires_at,?)+(SELECT days FROM membership_events WHERE event_key=?)*? WHERE user_id=? AND EXISTS(SELECT 1 FROM membership_events WHERE event_key=? AND user_id=? AND applied_at IS NULL)").bind(now, key, DAY, owner, key, owner),
    db.prepare("UPDATE membership_events SET applied_at=? WHERE event_key=? AND user_id=? AND applied_at IS NULL").bind(now, key, owner),
    db.prepare("INSERT OR IGNORE INTO membership_first_payments(user_id,card_hash,created_at) SELECT ?,code_hash,? FROM membership_cards WHERE code_hash=? AND redeemed_by=? AND redemption_id=? AND purpose='sale'").bind(owner, now, hash, owner, nonce),
    db.prepare("INSERT OR IGNORE INTO membership_events(event_key,user_id,days,reason,created_at) SELECT ?,i.inviter_id,3,'invite',? FROM membership_invites i JOIN membership_first_payments p ON p.user_id=i.invitee_id JOIN membership_cards c ON c.code_hash=p.card_hash WHERE i.invitee_id=? AND p.card_hash=? AND c.redemption_id=?").bind("invite-paid:" + owner, now, owner, hash, nonce),
    db.prepare("UPDATE membership_accounts SET expires_at=MAX(expires_at,?)+? WHERE user_id=(SELECT inviter_id FROM membership_invites WHERE invitee_id=?) AND NOT EXISTS(SELECT 1 FROM membership_permanent p WHERE p.user_id=membership_accounts.user_id) AND EXISTS(SELECT 1 FROM membership_events WHERE event_key=? AND user_id=membership_accounts.user_id AND applied_at IS NULL)").bind(now, 3 * DAY, owner, "invite-paid:" + owner),
    db.prepare("UPDATE membership_events SET applied_at=? WHERE event_key=? AND applied_at IS NULL").bind(now, "invite-paid:" + owner),
  ]);
  const card = await db.prepare("SELECT redeemed_by,redemption_id FROM membership_cards WHERE code_hash=? AND status='active'").bind(hash).first<{ redeemed_by: string; redemption_id: string }>();
  if (card?.redeemed_by !== owner) throw new HttpError(400, "兑换码无效或已使用，请核对后重试。");
  return { alreadyRedeemed: card.redemption_id !== nonce, ...await membershipStatus(env, owner, now) };
}

export async function createMembershipCards(env: Env, owner: string, quantity: number, label: string, now = Date.now(), days = MEMBER_DAYS, purpose = "sale") {
  assertMembershipSalesAllowed(env);
  const db = await ensureMembership(env);
  if (!await db.prepare("SELECT user_id FROM membership_admins WHERE user_id=?").bind(owner).first()) throw new HttpError(403, "没有卡密管理权限。");
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 200) throw new HttpError(400, "每批可生成 1—200 张会员卡。");
  if (days !== 7 && days !== 30) throw new HttpError(400, "请选择七天周卡或三十天月卡。");
  if (purpose !== "sale" && purpose !== "gift") throw new HttpError(400, "请选择售卖卡或赠送卡。");
  const batch = crypto.randomUUID();
  const codes = Array.from({ length: quantity }, () => {
    const value = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
    return "YY-" + value.match(/.{8}/g)!.join("-");
  });
  const hashes = await Promise.all(codes.map(code => digest(code.replace(/^YY-/, "").replaceAll("-", ""))));
  await db.batch([
    db.prepare("INSERT INTO membership_batches(id,label,days,quantity,created_at,created_by) VALUES(?,?,?,?,?,?)").bind(batch, label.trim().slice(0, 80) || "双站会员卡", days, quantity, now, owner),
    ...hashes.map(hash => db.prepare("INSERT INTO membership_cards(code_hash,batch_id,days,purpose,created_at) VALUES(?,?,?,?,?)").bind(hash, batch, days, purpose, now)),
  ]);
  return { batchId: batch, codes, days, purpose };
}

export function startMembershipJobs(env: Env) {
  let running = false;
  const tick = async () => {
    if (!membershipEnabled(env) || running) return;
    running = true;
    try {
      const cutoff = new Date(Date.now() - 10 * 60000).toISOString();
      if (env.AI_JOBS) {
        const stale = (await env.DB.prepare("SELECT id FROM reviews WHERE status='processing' AND created_at<?").bind(cutoff).all<{ id: string }>()).results;
        for (const row of stale) if (!env.AI_JOBS.isManaged(row.id))
          await env.DB.prepare("UPDATE reviews SET status='failed',error='批改进程中断或超时，请重新提交。' WHERE id=? AND status='processing' AND created_at<?").bind(row.id, cutoff).run();
      } else {
        await env.DB.prepare("UPDATE reviews SET status='failed',error='批改进程中断或超时，请重新提交。' WHERE status='processing' AND created_at<?").bind(cutoff).run();
      }
      await reconcileMembershipUsage(env);
      await reconcileEarlyMemberGifts(env);
    } catch { console.warn("Membership reconciliation will retry."); }
    finally { running = false; }
  };
  void tick();
  const timer = setInterval(() => { void tick(); }, 60000);
  timer.unref?.();
  return () => clearInterval(timer);
}

export async function membershipRoute(request: Request, env: Env): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/api/membership")) return null;
  if (freeAccessEnabled(env)) {
    if (path === "/api/membership" && request.method === "GET")
      return Response.json(await membershipStatus(env), { headers: { "Cache-Control": "no-store" } });
    throw new HttpError(410, freeAccessMessage, "FREE_ACCESS_ENABLED");
  }
  if (!membershipEnabled(env)) throw new HttpError(503, "会员功能暂未开放。");
  const shared = await promotionShareRoute(request, env);
  if (shared) return shared;
  if (path === "/api/membership" && request.method === "GET") {
    const user = await currentUser(request, env);
    return Response.json(await membershipStatus(env, user?.id), { headers: { "Cache-Control": "no-store" } });
  }
  const user = await requireUser(request, env);
  if (path === "/api/membership/promotion-checkout" && request.method === "GET") {
    const plan = new URL(request.url).searchParams.get("plan");
    if (plan !== "week" && plan !== "month") throw new HttpError(400, "请选择专享周卡或月卡。");
    if (!await membershipAccessEnabled(env)) throw new HttpError(503, "会员购买暂未开放。");
    const offer = await promotionForMember(env, user.id);
    const target = plan === "week" ? offer?.weekBuyUrl : offer?.monthBuyUrl;
    if (!target) throw new HttpError(403, "此购买入口仅对符合专属邀请资格的账号开放。");
    const db = await ensureMembership(env);
    if (await db.prepare("SELECT user_id FROM membership_permanent WHERE user_id=?").bind(user.id).first()) throw new HttpError(400, "你已拥有永久VIP，无需购买会员卡。");
    return new Response(null, { status: 302, headers: { Location: target, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  }
  if (path === "/api/membership/promotions" && request.method === "GET") {
    const params = new URL(request.url).searchParams;
    const number = (key: string) => params.has(key) ? Number(params.get(key)) : undefined;
    return Response.json(await adminPromotionReport(env, user.id, {
      inviterId: params.get("inviterId") || undefined, offset: number("offset"), limit: number("limit"),
      onlyRedeemed: params.get("onlyRedeemed") === "true", inviteeId: params.get("inviteeId") || undefined,
      redemptionOffset: number("redemptionOffset"), redemptionLimit: number("redemptionLimit"),
    }), { headers: { "Cache-Control": "no-store" } });
  }
  if (path === "/api/membership/redeem" && request.method === "POST") {
    assertOrigin(request);
    await rateLimit({ ...env, DB: identity(env) }, `member-redeem:${user.id}`, 12, 10 * 60000);
    const data = await body(request, 1000);
    if (typeof data.code !== "string" || data.code.length > 100) throw new HttpError(400, "请填写会员兑换码。");
    return Response.json(await redeemMembership(env, user.id, data.code));
  }
  if (path === "/api/membership/cards" && request.method === "POST") {
    assertOrigin(request);
    const data = await body(request, 1000);
    return Response.json(await createMembershipCards(env, user.id, data.quantity, typeof data.label === "string" ? data.label : "", Date.now(), data.days ?? MEMBER_DAYS, data.purpose ?? "sale"));
  }
  throw new HttpError(405, "请求方式不支持。");
}
