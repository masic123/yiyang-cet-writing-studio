import type { D1Database } from "@cloudflare/workers-types";
import { HttpError } from "../src/lib/http";
import { digest } from "./auth";
import { ensureMembership } from "./membership";
import type { Env } from "./types";

export const PROMOTION_DISCOUNT_BPS = 8500 as const;
const schemas = new WeakMap<D1Database, Promise<unknown>>();
const sale = "c.purpose='sale' AND c.redeemed_by IS NOT NULL AND c.redeemed_at IS NOT NULL";

/** Campaigns reuse established invitation relationships; they grant no membership or admin rights. */
export async function ensurePromotions(env: Env): Promise<D1Database> {
  const db = await ensureMembership(env);
  if (!schemas.has(db)) {
    const init = db.batch([
      db.prepare("CREATE TABLE IF NOT EXISTS promotion_campaigns(inviter_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,referral_code TEXT NOT NULL UNIQUE,discount_bps INTEGER NOT NULL DEFAULT 8500 CHECK(discount_bps=8500),created_at INTEGER NOT NULL,enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),week_buy_url TEXT,month_buy_url TEXT,coupon_code TEXT)"),
      db.prepare("CREATE TABLE IF NOT EXISTS promotion_shares(token_hash TEXT PRIMARY KEY CHECK(length(token_hash)=64 AND token_hash NOT GLOB '*[^0-9a-f]*'),inviter_id TEXT NOT NULL UNIQUE REFERENCES promotion_campaigns(inviter_id) ON DELETE CASCADE,created_at INTEGER NOT NULL,enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)))"),
      db.prepare("CREATE TABLE IF NOT EXISTS promotion_card_batches(batch_id TEXT PRIMARY KEY REFERENCES membership_batches(id),inviter_id TEXT NOT NULL REFERENCES promotion_campaigns(inviter_id),created_at INTEGER NOT NULL)"),
      db.prepare("CREATE INDEX IF NOT EXISTS promotion_invites_inviter ON membership_invites(inviter_id,created_at,invitee_id)"),
      db.prepare("CREATE INDEX IF NOT EXISTS promotion_sale_redemptions ON membership_cards(redeemed_by,redeemed_at) WHERE purpose='sale' AND redeemed_at IS NOT NULL"),
    ]).catch(error => { schemas.delete(db); throw error; });
    schemas.set(db, init);
  }
  await schemas.get(db);
  return db;
}

/** Append to the membership_cards UPDATE and bind the authenticated owner once.
 * Rechecks the fixed historical invitation inside the consuming transaction, even
 * when a restriction or relationship changes after the friendly pre-check.
 */
export const promotionCardRedemptionCondition = "NOT EXISTS(SELECT 1 FROM promotion_card_batches promotion_batch WHERE promotion_batch.batch_id=membership_cards.batch_id AND NOT EXISTS(SELECT 1 FROM membership_invites promotion_invite WHERE promotion_invite.invitee_id=? AND promotion_invite.inviter_id=promotion_batch.inviter_id))";

/** No card consumption or entitlement changes. Never trust an owner from request JSON. */
export async function assertPromotionCardEligible(env: Env, owner: string, hash: string): Promise<void> {
  const db = await ensurePromotions(env);
  const denied = await db.prepare("SELECT c.batch_id FROM membership_cards c JOIN promotion_card_batches p ON p.batch_id=c.batch_id WHERE c.code_hash=? AND NOT EXISTS(SELECT 1 FROM membership_invites i WHERE i.invitee_id=? AND i.inviter_id=p.inviter_id)").bind(hash, owner).first();
  if (denied) throw new HttpError(403, "此专享卡仅限通过指定推广邀请码注册的账号兑换。", "PROMOTION_CARD_ACCOUNT_MISMATCH");
}

function buyUrl(value: string | null) {
  // Only official item links are allowed. No coupon URL parameter is assumed.
  return value && value === value.trim() && /^https:\/\/catfk\.com\/item\/[A-Za-z0-9_-]+\/?$/i.test(value) ? value : null;
}

/** The caller must supply the authenticated user's ID, never a request-provided owner. */
export async function promotionForMember(env: Env, owner: string): Promise<{
  discountBps: typeof PROMOTION_DISCOUNT_BPS; weekBuyUrl: string | null; monthBuyUrl: string | null; couponCode: string | null;
} | null> {
  if (!owner) return null;
  const db = await ensurePromotions(env);
  const row = await db.prepare("SELECT p.week_buy_url,p.month_buy_url,p.coupon_code FROM membership_invites i JOIN promotion_campaigns p ON p.inviter_id=i.inviter_id WHERE i.invitee_id=? AND p.enabled=1").bind(owner).first<{ week_buy_url: string | null; month_buy_url: string | null; coupon_code: string | null }>();
  return row ? { discountBps: PROMOTION_DISCOUNT_BPS, weekBuyUrl: buyUrl(row.week_buy_url), monthBuyUrl: buyUrl(row.month_buy_url), couponCode: row.coupon_code?.trim() || null } : null;
}

/** Inviter self-service exposes their own offer, without invitees or financial records. */
export async function promotionForInviter(env: Env, owner: string): Promise<{
  discountBps: typeof PROMOTION_DISCOUNT_BPS; referralCode: string;
} | null> {
  if (!owner) return null;
  const db = await ensurePromotions(env);
  const row = await db.prepare("SELECT p.referral_code FROM promotion_campaigns p JOIN membership_accounts a ON a.user_id=p.inviter_id AND a.referral_code=p.referral_code WHERE p.inviter_id=? AND p.enabled=1").bind(owner).first<{ referral_code: string }>();
  return row ? { discountBps: PROMOTION_DISCOUNT_BPS, referralCode: row.referral_code } : null;
}

export type PromotionReportQuery = {
  inviterId?: string; offset?: number; limit?: number; onlyRedeemed?: boolean;
  /** Optional account filter applies only to the individually paged redemption ledger. */
  inviteeId?: string; redemptionOffset?: number; redemptionLimit?: number;
};
type Campaign = {
  inviterId: string; name: string; email: string; referralCode: string; enabled: boolean;
  discountBps: typeof PROMOTION_DISCOUNT_BPS; registeredUsers: number; saleRedeemedUsers: number;
  saleRedeemedCards: number; saleRedeemedDays: number; firstRedemptionAt: number | null; lastRedemptionAt: number | null;
};
type Summary = Pick<Campaign, "registeredUsers" | "saleRedeemedUsers" | "saleRedeemedCards" | "saleRedeemedDays" | "firstRedemptionAt" | "lastRedemptionAt">;
export type PromotionReportUser = {
  userId: string; name: string; email: string; registeredAt: string; invitedAt: number;
  saleRedeemedCards: number; saleRedeemedDays: number; firstRedemptionAt: number | null; lastRedemptionAt: number | null;
};
type Redemption = { userId: string; batchId: string; redemptionId: string | null; days: number; redeemedAt: number };
type Pagination = { offset: number; limit: number; total: number; hasMore: boolean };
export type PromotionReport = {
  campaigns: Campaign[]; selectedInviterId: string | null; summary: Summary;
  users: PromotionReportUser[]; pagination: Pagination;
  redemptions: Redemption[]; redemptionPagination: Pagination;
  paymentBasis: "sale-card-redemption";
};

function pageNumber(value: number | undefined, fallback: number, minimum: number, maximum: number) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new HttpError(400, "分页参数不正确。");
  return Math.min(value, maximum);
}
function ownerFilter(value: string | undefined) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw new HttpError(400, "账号筛选参数不正确。");
  return value.trim();
}
const pagination = (offset: number, limit: number, total: number): Pagination => ({ offset, limit, total, hasMore: offset + limit < total });
async function readCampaigns(db: D1Database, inviterId?: string): Promise<Campaign[]> {
  const rows = (await db.prepare(`WITH redemptions AS (
      SELECT c.redeemed_by,COUNT(*) AS cards,SUM(c.days) AS days,MIN(c.redeemed_at) AS first_at,MAX(c.redeemed_at) AS last_at
      FROM membership_cards c WHERE ${sale} GROUP BY c.redeemed_by)
    SELECT p.inviter_id AS inviterId,u.name,u.email,p.referral_code AS referralCode,p.enabled,p.discount_bps AS discountBps,
      COUNT(i.invitee_id) AS registeredUsers,COALESCE(SUM(CASE WHEN r.cards>0 THEN 1 ELSE 0 END),0) AS saleRedeemedUsers,
      COALESCE(SUM(r.cards),0) AS saleRedeemedCards,COALESCE(SUM(r.days),0) AS saleRedeemedDays,
      MIN(r.first_at) AS firstRedemptionAt,MAX(r.last_at) AS lastRedemptionAt
    FROM promotion_campaigns p JOIN users u ON u.id=p.inviter_id
    LEFT JOIN membership_invites i ON i.inviter_id=p.inviter_id LEFT JOIN redemptions r ON r.redeemed_by=i.invitee_id
    ${inviterId ? "WHERE p.inviter_id=?" : ""}
    GROUP BY p.inviter_id,u.name,u.email,p.referral_code,p.enabled,p.discount_bps,p.created_at ORDER BY p.created_at,p.inviter_id`).bind(...(inviterId ? [inviterId] : [])).all<Omit<Campaign, "enabled"> & { enabled: number }>()).results;
  return rows.map(row => ({ ...row, enabled: row.enabled === 1 }));
}
function campaignSummary(campaign?: Campaign): Summary {
  if (!campaign) return { registeredUsers: 0, saleRedeemedUsers: 0, saleRedeemedCards: 0, saleRedeemedDays: 0, firstRedemptionAt: null, lastRedemptionAt: null };
  const { registeredUsers, saleRedeemedUsers, saleRedeemedCards, saleRedeemedDays, firstRedemptionAt, lastRedemptionAt } = campaign;
  return { registeredUsers, saleRedeemedUsers, saleRedeemedCards, saleRedeemedDays, firstRedemptionAt, lastRedemptionAt };
}
function userPageQuery(query: Pick<PromotionReportQuery, "offset" | "limit" | "onlyRedeemed">) {
  const offset = pageNumber(query.offset, 0, 0, Number.MAX_SAFE_INTEGER), limit = pageNumber(query.limit, 50, 1, 100);
  if (query.onlyRedeemed !== undefined && typeof query.onlyRedeemed !== "boolean") throw new HttpError(400, "账号筛选参数不正确。");
  return { offset, limit, onlyRedeemed: query.onlyRedeemed === true };
}
async function readUserPage(db: D1Database, inviterId: string, page: ReturnType<typeof userPageQuery>) {
  const { offset, limit, onlyRedeemed } = page;
  const redeemedFilter = onlyRedeemed ? ` AND EXISTS(SELECT 1 FROM membership_cards c WHERE c.redeemed_by=i.invitee_id AND ${sale})` : "";
  const total = (await db.prepare(`SELECT COUNT(*) AS n FROM membership_invites i WHERE i.inviter_id=?${redeemedFilter}`).bind(inviterId).first<{ n: number }>())?.n || 0;
  const users = (await db.prepare(`SELECT u.id AS userId,u.name,u.email,u.created_at AS registeredAt,i.created_at AS invitedAt,
      COUNT(c.code_hash) AS saleRedeemedCards,COALESCE(SUM(c.days),0) AS saleRedeemedDays,
      MIN(c.redeemed_at) AS firstRedemptionAt,MAX(c.redeemed_at) AS lastRedemptionAt
    FROM membership_invites i JOIN users u ON u.id=i.invitee_id LEFT JOIN membership_cards c ON c.redeemed_by=i.invitee_id AND ${sale}
    WHERE i.inviter_id=?${redeemedFilter} GROUP BY u.id,u.name,u.email,u.created_at,i.created_at
    ORDER BY i.created_at DESC,i.invitee_id LIMIT ? OFFSET ?`).bind(inviterId, limit, offset).all<PromotionReportUser>()).results;
  return { users, pagination: pagination(offset, limit, total) };
}

/**
 * Counts sale cards actually redeemed, including every renewal. A redemption is not a
 * payment confirmation: gift cards, unredeemed stock and clicks never count; there is
 * no inference about order settlement, who paid, a discount used or money received.
 */
export async function adminPromotionReport(env: Env, admin: string, query: PromotionReportQuery = {}): Promise<PromotionReport> {
  const db = await ensurePromotions(env);
  if (!await db.prepare("SELECT user_id FROM membership_admins WHERE user_id=?").bind(admin).first()) throw new HttpError(403, "没有推广记录管理权限。");
  const page = userPageQuery(query), { offset, limit } = page;
  const redemptionOffset = pageNumber(query.redemptionOffset, 0, 0, Number.MAX_SAFE_INTEGER);
  const redemptionLimit = pageNumber(query.redemptionLimit, 50, 1, 100);
  const inviterId = ownerFilter(query.inviterId), inviteeId = ownerFilter(query.inviteeId);
  const campaigns = await readCampaigns(db);
  const selected = inviterId ? campaigns.find(row => row.inviterId === inviterId) : campaigns[0];
  if (inviterId && !selected) throw new HttpError(404, "未找到该推广活动。");
  if (!selected) return { campaigns, selectedInviterId: null, summary: campaignSummary(), users: [], pagination: pagination(offset, limit, 0), redemptions: [], redemptionPagination: pagination(redemptionOffset, redemptionLimit, 0), paymentBasis: "sale-card-redemption" };
  const summary = campaignSummary(selected), userPage = await readUserPage(db, selected.inviterId, page);
  const ledgerFilter = inviteeId ? " AND i.invitee_id=?" : "";
  const ledgerArgs = inviteeId ? [selected.inviterId, inviteeId] : [selected.inviterId];
  const redemptionTotal = (await db.prepare(`SELECT COUNT(*) AS n FROM membership_invites i JOIN membership_cards c ON c.redeemed_by=i.invitee_id AND ${sale} WHERE i.inviter_id=?${ledgerFilter}`).bind(...ledgerArgs).first<{ n: number }>())?.n || 0;
  const redemptions = (await db.prepare(`SELECT i.invitee_id AS userId,c.batch_id AS batchId,c.redemption_id AS redemptionId,c.days,c.redeemed_at AS redeemedAt
    FROM membership_invites i JOIN membership_cards c ON c.redeemed_by=i.invitee_id AND ${sale}
    WHERE i.inviter_id=?${ledgerFilter} ORDER BY c.redeemed_at DESC,c.code_hash LIMIT ? OFFSET ?`).bind(...ledgerArgs, redemptionLimit, redemptionOffset).all<Redemption>()).results;
  return { campaigns, selectedInviterId: selected.inviterId, summary, ...userPage, redemptions, redemptionPagination: pagination(redemptionOffset, redemptionLimit, redemptionTotal), paymentBasis: "sale-card-redemption" };
}

export type SharedPromotionReportQuery = Pick<PromotionReportQuery, "offset" | "limit" | "onlyRedeemed">;
export type SharedPromotionReport = {
  inviter: { name: string; email: string; referralCode: string }; summary: Summary;
  users: { name: string; email: string; registeredAt: string; saleRedeemedCards: number; saleRedeemedDays: number; lastRedemptionAt: number | null }[];
  pagination: Pagination; updatedAt: number; paymentBasis: "sale-card-redemption";
};
function maskedEmail(email: string) {
  const separator = email.lastIndexOf("@");
  return separator > 0 ? `${Array.from(email.slice(0, separator)).slice(0, 2).join("")}***${email.slice(separator)}` : "***";
}

/** Bearer capability: read-only, exactly one inviter, masked contacts and no admin impersonation. */
export async function sharedPromotionReport(env: Env, rawToken: string, query: SharedPromotionReportQuery = {}): Promise<SharedPromotionReport> {
  if (typeof rawToken !== "string" || rawToken.length !== 64 || !/^[a-fA-F0-9]{64}$/.test(rawToken)) throw new HttpError(404, "该分享链接不可用。");
  const db = await ensurePromotions(env);
  const share = await db.prepare("SELECT s.inviter_id FROM promotion_shares s JOIN promotion_campaigns p ON p.inviter_id=s.inviter_id WHERE s.token_hash=? AND s.enabled=1 AND p.enabled=1").bind(await digest(rawToken)).first<{ inviter_id: string }>();
  if (!share) throw new HttpError(404, "该分享链接不可用。");
  const page = userPageQuery(query), campaign = (await readCampaigns(db, share.inviter_id))[0];
  if (!campaign?.enabled) throw new HttpError(404, "该分享链接不可用。");
  const userPage = await readUserPage(db, share.inviter_id, page);
  return {
    inviter: { name: campaign.name, email: maskedEmail(campaign.email), referralCode: campaign.referralCode },
    summary: campaignSummary(campaign),
    users: userPage.users.map(row => ({ name: row.name, email: maskedEmail(row.email), registeredAt: row.registeredAt, saleRedeemedCards: row.saleRedeemedCards, saleRedeemedDays: row.saleRedeemedDays, lastRedemptionAt: row.lastRedemptionAt })),
    pagination: userPage.pagination, updatedAt: Date.now(), paymentBasis: "sale-card-redemption",
  };
}

export async function promotionShareRoute(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/membership/promotion-share") return null;
  const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
  if (request.method !== "GET") return Response.json({ error: "仅支持只读访问。" }, { status: 405, headers: { ...headers, Allow: "GET" } });
  const authorization = request.headers.get("authorization");
  if (!authorization) return Response.json({ error: "请使用完整的推广分享链接。" }, { status: 401, headers });
  const match = authorization.length === 71 ? authorization.match(/^Bearer ([a-fA-F0-9]{64})$/i) : null;
  if (!match) return Response.json({ error: "该分享链接不可用。" }, { status: 404, headers });
  const number = (key: string) => url.searchParams.has(key) ? Number(url.searchParams.get(key)) : undefined;
  const onlyRedeemed = url.searchParams.get("onlyRedeemed");
  try {
    if (onlyRedeemed !== null && onlyRedeemed !== "true" && onlyRedeemed !== "false") throw new HttpError(400, "账号筛选参数不正确。");
    return Response.json(await sharedPromotionReport(env, match[1], { offset: number("offset"), limit: number("limit"), onlyRedeemed: onlyRedeemed === "true" }), { headers });
  } catch (error) {
    if (error instanceof HttpError) return Response.json({ error: error.message }, { status: error.status, headers });
    return Response.json({ error: "暂时无法读取推广记录，请稍后重试。" }, { status: 500, headers });
  }
}
