import { test } from "node:test";
import assert from "node:assert/strict";
import { sqliteDatabase } from "../server/database";
import { HttpError } from "../src/lib/http";
import { createSession, digest } from "../worker/auth";
import { createMembershipCards, membershipRoute, redeemMembership, registrationMembershipStatements } from "../worker/membership";
import { adminPromotionReport, assertPromotionCardEligible, ensurePromotions, promotionCardRedemptionCondition, promotionForInviter, promotionForMember, promotionShareRoute, sharedPromotionReport } from "../worker/promotion";
import type { Env } from "../worker/types";

const CODE = "AB12CD34EF", NOW = Date.parse("2026-11-02T02:00:00Z");
const status = (expected: number) => (error: unknown) => error instanceof HttpError && error.status === expected;
async function fixture(t: { after: (fn: () => void) => void }, campaign = true) {
  const identity = sqliteDatabase(":memory:"), site = sqliteDatabase(":memory:"), otherSite = sqliteDatabase(":memory:");
  t.after(() => { identity.sql.close(); site.sql.close(); otherSite.sql.close(); });
  const env = { DB: site.db, AUTH_DB: identity.db, MEMBERSHIP_ENABLED: "true", MEMBERSHIP_SITE: "cet" } as Env;
  const other = { ...env, DB: otherSite.db, MEMBERSHIP_SITE: "ielts" };
  await ensurePromotions(env);
  function user(id: string, at = NOW - 1000) {
    identity.sql.prepare("INSERT INTO users(id,name,email,password,created_at) VALUES(?,?,?,?,?)").run(id, `同学 ${id}`, `${id}@example.test`, "PRIVATE_PASSWORD_HASH", new Date(at).toISOString());
  }
  for (const id of ["admin", "blogger", "outsider"]) user(id);
  identity.sql.prepare("INSERT INTO membership_admins(user_id) VALUES('admin')").run();
  identity.sql.prepare("INSERT INTO membership_accounts(user_id,referral_code) VALUES('blogger',?)").run(CODE);
  function enable(inviter = "blogger", code = CODE) {
    identity.sql.prepare("INSERT INTO promotion_campaigns(inviter_id,referral_code,created_at,week_buy_url,month_buy_url,coupon_code) VALUES(?,?,?,'https://catfk.com/item/week-85','https://catfk.com/item/month_85',' SAVE85 ')").run(inviter, code, NOW);
  }
  if (campaign) enable();
  function invite(id: string, inviter = "blogger", at = NOW - 100) {
    user(id, at - 50);
    identity.sql.prepare("INSERT INTO membership_invites(invitee_id,inviter_id,created_at) VALUES(?,?,?)").run(id, inviter, at);
  }
  async function register(id: string) {
    const statements = await registrationMembershipStatements(other, id, CODE, NOW + 1);
    await identity.db.batch([identity.db.prepare("INSERT INTO users(id,name,email,password,created_at) VALUES(?,?,?,?,?)").bind(id, `同学 ${id}`, `${id}@example.test`, "PRIVATE_PASSWORD_HASH", new Date(NOW + 1).toISOString()), ...statements]);
  }
  async function redeem(owner: string, days: number, purpose = "sale", at = NOW, target = env) {
    const batch = await createMembershipCards(target, "admin", 1, "fixture", at - 1, days, purpose);
    await redeemMembership(target, owner, batch.codes[0], at);
    return identity.sql.prepare("SELECT code_hash FROM membership_cards WHERE batch_id=?").get(batch.batchId)!.code_hash as string;
  }
  function rawCard(id: string, owner: string | null, at: number | null, purpose = "sale", days = 7) {
    identity.sql.prepare("INSERT OR IGNORE INTO membership_batches(id,label,days,quantity,created_at,created_by) VALUES('raw-fixture','fixture',7,200,?,'admin')").run(NOW);
    identity.sql.prepare("INSERT INTO membership_cards(code_hash,batch_id,days,purpose,created_at,redeemed_by,redeemed_at,redemption_id) VALUES(?,'raw-fixture',?,?,?,?,?,?)").run(`PRIVATE_CARD_HASH_${id}`, days, purpose, NOW - 1, owner, at, at === null ? null : `redemption-${id}`);
  }
  async function restricted(days = 7, purpose = "sale") {
    const batch = await createMembershipCards(env, "admin", 1, "restricted fixture", NOW - 1, days, purpose);
    identity.sql.prepare("INSERT INTO promotion_card_batches VALUES(?,'blogger',?)").run(batch.batchId, NOW);
    const hash = identity.sql.prepare("SELECT code_hash FROM membership_cards WHERE batch_id=?").get(batch.batchId)!.code_hash as string;
    return { batchId: batch.batchId, code: batch.codes[0], hash };
  }
  const redemptionSnapshot = () => Object.fromEntries(["membership_cards", "membership_accounts", "membership_events", "membership_first_payments", "membership_permanent"].map(table => [table, identity.sql.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  return { identity, site, otherSite, env, other, user, enable, invite, register, redeem, rawCard, restricted, redemptionSnapshot };
}

test("promotion schema uses shared identity, enforces fixed discount and grants no account or administrator rights", async t => {
  const f = await fixture(t, false);
  const before = f.identity.sql.prepare("SELECT * FROM membership_accounts").all();
  assert.equal(await ensurePromotions(f.env), f.identity.db);
  assert.equal(await ensurePromotions(f.other), f.identity.db);
  f.enable();
  assert.throws(() => f.identity.sql.prepare("INSERT INTO promotion_campaigns(inviter_id,referral_code,discount_bps,created_at) VALUES('outsider','INVALID',9000,?)").run(NOW), /CHECK/);
  assert.throws(() => f.identity.sql.prepare("UPDATE promotion_campaigns SET enabled=2").run(), /CHECK/);
  assert.throws(() => f.identity.sql.prepare("INSERT INTO promotion_campaigns(inviter_id,referral_code,created_at) VALUES('outsider',?,?)").run(CODE, NOW), /UNIQUE/);
  assert.throws(() => f.identity.sql.prepare("INSERT INTO promotion_campaigns(inviter_id,referral_code,created_at) VALUES('missing','NOUSER',?)").run(NOW), /FOREIGN KEY/);
  assert.deepEqual(f.identity.sql.prepare("SELECT * FROM membership_accounts").all(), before);
  assert.deepEqual(f.identity.sql.prepare("SELECT user_id FROM membership_admins").all().map(row => row.user_id), ["admin"]);
  assert.equal(f.site.sql.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='promotion_campaigns'").get()!.n, 0);
  assert.equal(f.otherSite.sql.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='promotion_campaigns'").get()!.n, 0);
});

test("existing and future invitees qualify on both sites without exposing identities or changing registration gifts", async t => {
  const f = await fixture(t, false); f.invite("historical"); f.enable(); await f.register("future");
  f.identity.sql.prepare("INSERT INTO membership_permanent VALUES('historical',?)").run(NOW - 1000);
  const before = f.identity.sql.prepare("SELECT * FROM membership_accounts ORDER BY user_id").all();
  const expected = { discountBps: 8500, weekBuyUrl: "https://catfk.com/item/week-85", monthBuyUrl: "https://catfk.com/item/month_85", couponCode: "SAVE85" };
  assert.deepEqual(await promotionForMember(f.env, "historical"), expected);
  assert.deepEqual(await promotionForMember(f.other, "historical"), expected);
  assert.deepEqual(await promotionForMember(f.env, "future"), expected);
  assert.equal(await promotionForMember(f.other, "outsider"), null);
  assert.equal(await promotionForMember(f.env, "blogger"), null);
  assert.equal(await promotionForMember(f.env, ""), null);
  assert.deepEqual(await promotionForInviter(f.other, "blogger"), { discountBps: 8500, referralCode: CODE });
  assert.equal(await promotionForInviter(f.env, "outsider"), null);
  assert.equal(await promotionForInviter(f.env, ""), null);
  const serialized = JSON.stringify(expected);
  for (const privateValue of ["blogger", "@example.test", CODE, "historical", "PRIVATE_PASSWORD_HASH"]) assert.ok(!serialized.includes(privateValue));
  assert.deepEqual(f.identity.sql.prepare("SELECT * FROM membership_accounts ORDER BY user_id").all(), before);
  assert.equal(f.identity.sql.prepare("SELECT days FROM membership_events WHERE event_key='registration-welcome:future'").get()!.days, 1);
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM membership_permanent WHERE user_id='historical'").get()!.n, 1);
});

test("disabling an offer hides eligibility without deleting history; rotating the inviter code hides stale self-service", async t => {
  const f = await fixture(t); f.invite("history");
  f.identity.sql.prepare("UPDATE membership_accounts SET referral_code='ROTATED123' WHERE user_id='blogger'").run();
  assert.equal(await promotionForInviter(f.env, "blogger"), null);
  assert.equal((await promotionForMember(f.other, "history"))!.discountBps, 8500);
  f.identity.sql.prepare("UPDATE promotion_campaigns SET enabled=0").run();
  assert.equal(await promotionForMember(f.env, "history"), null);
  assert.equal(await promotionForInviter(f.env, "blogger"), null);
  const report = await adminPromotionReport(f.other, "admin");
  assert.equal(report.campaigns[0].enabled, false); assert.equal(report.summary.registeredUsers, 1);
  assert.equal(f.identity.sql.prepare("SELECT inviter_id FROM membership_invites WHERE invitee_id='history'").get()!.inviter_id, "blogger");
});

test("eligible links allow official HTTPS item paths only and never assume a coupon query parameter", async t => {
  const f = await fixture(t); f.invite("friend");
  for (const url of [null, "", "http://catfk.com/item/123", "https://elsewhere.test/item/123", "https://catfk.com.evil.test/item/123", "https://person@catfk.com/item/123", "https://catfk.com:443/item/123", "https://catfk.com:8443/item/123", "https://catfk.com/item/123?coupon=SAVE85", "https://catfk.com/item/123#coupon", "https://catfk.com/admin/123", "https://catfk.com/item/123/nested", "javascript:alert(1)", "https://catfk.com/item/123\n"]) {
    f.identity.sql.prepare("UPDATE promotion_campaigns SET week_buy_url=?").run(url);
    const result = (await promotionForMember(f.env, "friend"))!;
    assert.equal(result.weekBuyUrl, null, String(url));
    assert.equal(result.monthBuyUrl, "https://catfk.com/item/month_85");
  }
  for (const url of ["https://catfk.com/item/123", "https://catfk.com/item/valid_slug-85/"]) {
    f.identity.sql.prepare("UPDATE promotion_campaigns SET week_buy_url=?").run(url);
    assert.equal((await promotionForMember(f.other, "friend"))!.weekBuyUrl, url);
  }
  f.identity.sql.prepare("UPDATE promotion_campaigns SET coupon_code=NULL,week_buy_url=NULL,month_buy_url=NULL").run();
  assert.deepEqual(await promotionForMember(f.env, "friend"), { discountBps: 8500, weekBuyUrl: null, monthBuyUrl: null, couponCode: null });
});

test("only existing membership administrators can read promotion identities and ledgers", async t => {
  const f = await fixture(t); f.invite("friend");
  for (const owner of ["", "blogger", "friend", "outsider", "admin' OR 1=1 --"]) await assert.rejects(adminPromotionReport(f.env, owner), status(403));
  await assert.rejects(adminPromotionReport(f.env, "blogger", { limit: -1 }), status(403));
  const report = await adminPromotionReport(f.other, "admin");
  assert.equal(report.users[0].email, "friend@example.test");
  assert.equal(report.campaigns[0].email, "blogger@example.test");
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM membership_admins WHERE user_id='blogger'").get()!.n, 0);
});

test("dynamic shared reports count every sale-card renewal and exclude gifts, stock, incomplete fields and unrelated accounts", async t => {
  const f = await fixture(t); f.invite("buyer"); f.invite("gift-only"); f.invite("no-cards");
  await f.redeem("buyer", 7, "sale", NOW);
  await f.redeem("buyer", 30, "sale", NOW + 20, f.other);
  const giftHash = await f.redeem("gift-only", 30, "gift", NOW + 30);
  await f.redeem("outsider", 30, "sale", NOW + 40);
  f.identity.sql.prepare("INSERT INTO membership_first_payments(user_id,card_hash,created_at) VALUES('gift-only',?,?)").run(giftHash, NOW + 30);
  f.rawCard("stock", null, null); f.rawCard("missing-time", "no-cards", null); f.rawCard("missing-owner", null, NOW);
  const report = await adminPromotionReport(f.other, "admin");
  assert.deepEqual(report.summary, { registeredUsers: 3, saleRedeemedUsers: 1, saleRedeemedCards: 2, saleRedeemedDays: 37, firstRedemptionAt: NOW, lastRedemptionAt: NOW + 20 });
  assert.equal(report.paymentBasis, "sale-card-redemption");
  const buyer = report.users.find(row => row.userId === "buyer")!;
  assert.equal(buyer.saleRedeemedCards, 2); assert.equal(buyer.saleRedeemedDays, 37);
  assert.equal(buyer.firstRedemptionAt, NOW); assert.equal(buyer.lastRedemptionAt, NOW + 20);
  assert.equal(typeof buyer.registeredAt, "string"); assert.equal(typeof buyer.invitedAt, "number");
  const gift = report.users.find(row => row.userId === "gift-only")!;
  assert.equal(gift.saleRedeemedCards, 0); assert.equal(gift.firstRedemptionAt, null); assert.equal(gift.lastRedemptionAt, null);
  assert.deepEqual(report.redemptions.map(row => [row.userId, row.days, row.redeemedAt]), [["buyer", 30, NOW + 20], ["buyer", 7, NOW]]);
  const serialized = JSON.stringify(report);
  for (const hidden of ["PRIVATE_PASSWORD_HASH", "PRIVATE_CARD_HASH", "code_hash", "card_hash", "amountFen", "paidAmount", "paymentConfirmed", "weekBuyUrl", "SAVE85"]) assert.ok(!serialized.includes(hidden), hidden);
  await f.redeem("buyer", 7, "sale", NOW + 100, f.other);
  const refreshed = await adminPromotionReport(f.env, "admin");
  assert.equal(refreshed.summary.saleRedeemedCards, 3); assert.equal(refreshed.summary.saleRedeemedUsers, 1); assert.equal(refreshed.summary.saleRedeemedDays, 44);
  assert.equal(refreshed.redemptionPagination.total, 3);
});

test("report selection and account ledger filters stay scoped and parameterized", async t => {
  const f = await fixture(t); f.invite("first"); f.invite("second"); f.invite("other-friend", "outsider");
  f.enable("outsider", "OTHER12345");
  f.rawCard("first-a", "first", NOW); f.rawCard("first-b", "first", NOW + 10); f.rawCard("second", "second", NOW + 20); f.rawCard("outside", "other-friend", NOW + 30);
  const one = await adminPromotionReport(f.other, "admin", { inviterId: "blogger", inviteeId: "first", redemptionLimit: 1 });
  assert.equal(one.summary.saleRedeemedCards, 3); assert.equal(one.redemptions.length, 1); assert.equal(one.redemptions[0].userId, "first");
  assert.deepEqual(one.redemptionPagination, { offset: 0, limit: 1, total: 2, hasMore: true });
  const two = await adminPromotionReport(f.env, "admin", { inviterId: "blogger", inviteeId: "first", redemptionOffset: 1, redemptionLimit: 1 });
  assert.notEqual(one.redemptions[0].redemptionId, two.redemptions[0].redemptionId); assert.equal(two.redemptionPagination.hasMore, false);
  const out = await adminPromotionReport(f.env, "admin", { inviterId: "blogger", inviteeId: "other-friend" }); assert.equal(out.redemptions.length, 0);
  const injected = await adminPromotionReport(f.env, "admin", { inviterId: "blogger", inviteeId: "' OR 1=1 --" }); assert.equal(injected.redemptionPagination.total, 0);
  await assert.rejects(adminPromotionReport(f.env, "admin", { inviterId: "' OR 1=1 --" }), status(404));
  const other = await adminPromotionReport(f.env, "admin", { inviterId: "outsider" }); assert.equal(other.summary.registeredUsers, 1); assert.equal(other.redemptions[0].userId, "other-friend");
});

test("registered-user and redemption pagination are bounded, stable and correctly filter redeemed accounts", async t => {
  const f = await fixture(t);
  for (let index = 0; index < 105; index++) {
    const id = `friend-${String(index).padStart(3, "0")}`; f.invite(id);
    if (index < 5) f.rawCard(id, id, NOW);
  }
  const first = await adminPromotionReport(f.env, "admin", { limit: 1000, redemptionLimit: 1000 });
  assert.deepEqual(first.pagination, { offset: 0, limit: 100, total: 105, hasMore: true });
  assert.equal(first.redemptionPagination.limit, 100);
  const second = await adminPromotionReport(f.other, "admin", { limit: 100, offset: 100 });
  assert.deepEqual(second.pagination, { offset: 100, limit: 100, total: 105, hasMore: false });
  assert.equal(new Set([...first.users, ...second.users].map(row => row.userId)).size, 105);
  const filtered = await adminPromotionReport(f.env, "admin", { onlyRedeemed: true, limit: 2, offset: 2 });
  assert.equal(filtered.pagination.total, 5); assert.equal(filtered.users.length, 2); assert.equal(filtered.pagination.hasMore, true);
  assert.equal(filtered.summary.registeredUsers, 105); assert.equal(filtered.summary.saleRedeemedUsers, 5);
  assert.ok(filtered.users.every(row => row.saleRedeemedCards === 1));
  const past = await adminPromotionReport(f.env, "admin", { offset: 500 }); assert.equal(past.users.length, 0); assert.equal(past.pagination.hasMore, false);
});

test("invalid pagination cannot become SQL and empty campaign lists remain well formed", async t => {
  const f = await fixture(t, false);
  const report = await adminPromotionReport(f.env, "admin");
  assert.equal(report.selectedInviterId, null); assert.equal(report.summary.registeredUsers, 0); assert.deepEqual(report.users, []); assert.deepEqual(report.redemptions, []);
  for (const query of [{ limit: 0 }, { offset: -1 }, { limit: NaN }, { offset: Infinity }, { offset: 0.5 }, { limit: "1; DROP TABLE users" }, { onlyRedeemed: "false" }, { inviterId: "" }, { redemptionLimit: -1 }, { redemptionOffset: "0 UNION SELECT" }]) {
    await assert.rejects(adminPromotionReport(f.env, "admin", query as never), status(400));
  }
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM users").get()!.n, 3);
});

test("opaque shared reports scope one campaign, mask contacts, omit internal identifiers and stay live across sites", async t => {
  const f = await fixture(t); f.invite("friend"); f.invite("gift-only"); f.invite("other-friend", "outsider"); f.enable("outsider", "OTHER12345");
  f.identity.sql.prepare("UPDATE users SET name='推广博主',email='abprivate@creator.test' WHERE id='blogger'").run();
  f.identity.sql.prepare("UPDATE users SET name='张同学',email='cdprivate@reader.test' WHERE id='friend'").run();
  const token = "a1".repeat(32), tokenHash = await digest(token);
  f.identity.sql.prepare("INSERT INTO promotion_shares(token_hash,inviter_id,created_at) VALUES(?,'blogger',?)").run(tokenHash, NOW);
  f.rawCard("shared-sale", "friend", NOW); f.rawCard("shared-gift", "gift-only", NOW, "gift"); f.rawCard("other-sale", "other-friend", NOW);
  const report = await sharedPromotionReport(f.other, token, { inviterId: "outsider", inviteeId: "other-friend" } as never);
  assert.deepEqual(report.inviter, { name: "推广博主", email: "ab***@creator.test", referralCode: CODE });
  assert.equal(report.summary.registeredUsers, 2); assert.equal(report.summary.saleRedeemedUsers, 1); assert.equal(report.summary.saleRedeemedCards, 1);
  assert.equal(report.paymentBasis, "sale-card-redemption"); assert.ok(Math.abs(Date.now() - report.updatedAt) < 1000);
  const friend = report.users.find(row => row.name === "张同学")!;
  assert.equal(friend.email, "cd***@reader.test"); assert.equal(friend.lastRedemptionAt, NOW);
  assert.deepEqual(Object.keys(friend).sort(), ["name", "email", "registeredAt", "saleRedeemedCards", "saleRedeemedDays", "lastRedemptionAt"].sort());
  const serialized = JSON.stringify(report);
  for (const hidden of [token, tokenHash, "PRIVATE_CARD_HASH", "PRIVATE_PASSWORD_HASH", "abprivate", "cdprivate", "outsider", "other-friend", "OTHER12345", "SAVE85", "couponCode", "userId", "inviterId", "campaigns", "redemptions", "password", "code_hash"]) assert.ok(!serialized.includes(hidden), hidden);
  const stored = f.identity.sql.prepare("SELECT * FROM promotion_shares").get()!;
  assert.equal(stored.token_hash, tokenHash); assert.notEqual(stored.token_hash, token);
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM membership_admins WHERE user_id='blogger'").get()!.n, 0);
  f.rawCard("shared-renewal", "friend", NOW + 100, "sale", 30);
  assert.equal((await sharedPromotionReport(f.env, token)).summary.saleRedeemedCards, 2);
  assert.equal((await sharedPromotionReport(f.env, token)).summary.saleRedeemedDays, 37);
});

test("shared reports reject unknown, malformed, revoked or disabled capabilities and keep private rows out of errors", async t => {
  const f = await fixture(t); f.invite("friend");
  const token = "b2".repeat(32), tokenHash = await digest(token);
  f.identity.sql.prepare("INSERT INTO promotion_shares(token_hash,inviter_id,created_at) VALUES(?,'blogger',?)").run(tokenHash, NOW);
  for (const raw of ["", "b".repeat(63), "g".repeat(64), `${token}\n`, "' OR 1=1 --", "c3".repeat(32)]) await assert.rejects(sharedPromotionReport(f.env, raw), status(404));
  assert.throws(() => f.identity.sql.prepare("INSERT INTO promotion_shares(token_hash,inviter_id,created_at) VALUES('not-a-sha256','outsider',?)").run(NOW), /CHECK/);
  assert.throws(() => f.identity.sql.prepare("INSERT INTO promotion_shares(token_hash,inviter_id,created_at) VALUES(?,'blogger',?)").run("c".repeat(64), NOW), /UNIQUE/);
  f.identity.sql.prepare("UPDATE promotion_shares SET enabled=0").run();
  await assert.rejects(sharedPromotionReport(f.other, token), status(404));
  f.identity.sql.prepare("UPDATE promotion_shares SET enabled=1").run();
  f.identity.sql.prepare("UPDATE promotion_campaigns SET enabled=0").run();
  await assert.rejects(sharedPromotionReport(f.env, token), status(404));
  f.identity.sql.prepare("UPDATE promotion_campaigns SET enabled=1").run();
  const replacement = "d4".repeat(32);
  f.identity.sql.prepare("UPDATE promotion_shares SET token_hash=?").run(await digest(replacement));
  await assert.rejects(sharedPromotionReport(f.env, token), status(404));
  assert.equal((await sharedPromotionReport(f.env, replacement)).summary.registeredUsers, 1);
});

test("shared endpoint uses Bearer only, never a query token, and all responses disable cache and referrers", async t => {
  const f = await fixture(t); f.invite("friend");
  const token = "e5".repeat(32);
  f.identity.sql.prepare("INSERT INTO promotion_shares(token_hash,inviter_id,created_at) VALUES(?,'blogger',?)").run(await digest(token), NOW);
  const request = (suffix = "", authorization: string | null = `Bearer ${token}`, method = "GET") => new Request(`https://writing.example/api/membership/promotion-share${suffix}`, { method, headers: authorization ? { authorization } : {} });
  const responses = [
    await promotionShareRoute(request(`?token=${token}`, null), f.env),
    await promotionShareRoute(request("", "Bearer invalid"), f.env),
    await promotionShareRoute(request("", `Bearer ${token}`, "POST"), f.env),
    await promotionShareRoute(request("?offset=0;DROP%20TABLE%20users"), f.env),
    await promotionShareRoute(request("?onlyRedeemed=invalid"), f.env),
    await promotionShareRoute(request("?inviterId=outsider&limit=999"), f.other),
  ];
  assert.deepEqual(responses.map(response => response!.status), [401, 404, 405, 400, 400, 200]);
  for (const response of responses) {
    assert.equal(response!.headers.get("cache-control"), "no-store"); assert.equal(response!.headers.get("referrer-policy"), "no-referrer");
  }
  const result = await responses[5]!.json() as { inviter: { referralCode: string }; pagination: { limit: number } };
  assert.equal(result.inviter.referralCode, CODE); assert.equal(result.pagination.limit, 100);
  assert.equal(await promotionShareRoute(new Request("https://writing.example/api/unrelated"), f.env), null);
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM users").get()!.n, 4);
});

test("shared pagination stays bounded and only-redeemed filtering does not alter campaign totals", async t => {
  const f = await fixture(t); const token = "f6".repeat(32);
  f.identity.sql.prepare("INSERT INTO promotion_shares(token_hash,inviter_id,created_at) VALUES(?,'blogger',?)").run(await digest(token), NOW);
  for (let index = 0; index < 4; index++) { f.invite(`share-${index}`); if (index < 3) f.rawCard(`share-${index}`, `share-${index}`, NOW); }
  const first = await sharedPromotionReport(f.env, token, { onlyRedeemed: true, offset: 0, limit: 2 });
  const last = await sharedPromotionReport(f.other, token, { onlyRedeemed: true, offset: 2, limit: 2 });
  assert.equal(first.summary.registeredUsers, 4); assert.equal(first.pagination.total, 3); assert.equal(first.pagination.hasMore, true);
  assert.equal(last.users.length, 1); assert.equal(last.pagination.hasMore, false);
  assert.equal(new Set([...first.users, ...last.users].map(row => row.name)).size, 3);
  await assert.rejects(sharedPromotionReport(f.env, token, { limit: "1 UNION SELECT" } as never), status(400));
});

test("restricted sale cards redeem and renew across sites for historical eligible invitees and enter live reports", async t => {
  const f = await fixture(t); f.invite("eligible");
  const week = await f.restricted(), month = await f.restricted(30);
  await assertPromotionCardEligible(f.env, "eligible", week.hash);
  await redeemMembership(f.env, "eligible", week.code, NOW);
  await redeemMembership(f.other, "eligible", month.code, NOW + 1);
  assert.equal(f.identity.sql.prepare("SELECT expires_at FROM membership_accounts WHERE user_id='eligible'").get()!.expires_at, NOW + 37 * 86400_000);
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM membership_first_payments WHERE user_id='eligible'").get()!.n, 1);
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM membership_events WHERE event_key='invite-paid:eligible'").get()!.n, 1);
  const report = await adminPromotionReport(f.other, "admin"); assert.equal(report.summary.saleRedeemedCards, 2); assert.equal(report.summary.saleRedeemedDays, 37);
  const token = "b7".repeat(32);
  f.identity.sql.prepare("INSERT INTO promotion_shares VALUES(?,'blogger',?,1)").run(await digest(token), NOW);
  const shared = await sharedPromotionReport(f.env, token); assert.equal(shared.summary.saleRedeemedCards, 2); assert.equal(shared.summary.saleRedeemedUsers, 1);
});

test("uninvited, other-inviter and nonexistent accounts cannot consume restricted sale or gift cards or gain rewards", async t => {
  const f = await fixture(t); f.invite("other-friend", "outsider");
  const saleCard = await f.restricted(), giftCard = await f.restricted(30, "gift");
  const before = f.redemptionSnapshot();
  for (const env of [f.env, f.other]) for (const owner of ["outsider", "other-friend", "missing"]) for (const card of [saleCard, giftCard]) {
    await assert.rejects(assertPromotionCardEligible(env, owner, card.hash), error => status(403)(error) && (error as HttpError).code === "PROMOTION_CARD_ACCOUNT_MISMATCH");
    await assert.rejects(redeemMembership(env, owner, card.code, NOW), status(403));
    assert.deepEqual(f.redemptionSnapshot(), before);
  }
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM membership_cards WHERE redeemed_at IS NOT NULL").get()!.n, 0);
});

test("campaign suspension and referral rotation preserve already-purchased restricted-card eligibility", async t => {
  const f = await fixture(t); f.invite("historical-buyer"); const card = await f.restricted();
  f.identity.sql.prepare("UPDATE promotion_campaigns SET enabled=0").run();
  f.identity.sql.prepare("UPDATE membership_accounts SET referral_code='ROTATED123' WHERE user_id='blogger'").run();
  assert.equal(await promotionForMember(f.env, "historical-buyer"), null);
  await redeemMembership(f.other, "historical-buyer", card.code, NOW);
  assert.equal(f.identity.sql.prepare("SELECT redeemed_by FROM membership_cards WHERE code_hash=?").get(card.hash)!.redeemed_by, "historical-buyer");
  assert.equal((await adminPromotionReport(f.env, "admin")).summary.saleRedeemedCards, 1);
  assert.throws(() => f.identity.sql.prepare("DELETE FROM promotion_campaigns WHERE inviter_id='blogger'").run(), /FOREIGN KEY/);
});

test("unrestricted sale and gift batches retain ordinary redemption behavior for unrelated accounts", async t => {
  const f = await fixture(t);
  await assertPromotionCardEligible(f.env, "outsider", "nonexistent-card-hash");
  await f.redeem("outsider", 7, "sale", NOW); await f.redeem("outsider", 30, "gift", NOW + 1, f.other);
  assert.equal(f.identity.sql.prepare("SELECT expires_at FROM membership_accounts WHERE user_id='outsider'").get()!.expires_at, NOW + 37 * 86400_000);
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM promotion_card_batches").get()!.n, 0);
});

test("the consuming UPDATE atomically rechecks eligibility when an invitation changes after the friendly precheck", async t => {
  const f = await fixture(t); f.invite("racy"); const card = await f.restricted();
  f.identity.sql.prepare("INSERT INTO membership_accounts(user_id,referral_code) VALUES('racy','RACY123456')").run();
  await assertPromotionCardEligible(f.env, "racy", card.hash);
  const before = f.redemptionSnapshot(), database = f.identity.db, originalBatch = database.batch;
  let interleaved = false;
  database.batch = (async (statements: Parameters<typeof database.batch>[0]) => {
    if (statements.some(statement => ((statement as unknown as { source: string }).source || "").startsWith("UPDATE membership_cards SET redeemed_by="))) {
      interleaved = true;
      f.identity.sql.prepare("UPDATE membership_invites SET inviter_id='outsider' WHERE invitee_id='racy'").run();
    }
    return originalBatch.call(database, statements);
  }) as typeof database.batch;
  try { await assert.rejects(redeemMembership(f.env, "racy", card.code, NOW)); }
  finally { database.batch = originalBatch; }
  assert.equal(interleaved, true); assert.deepEqual(f.redemptionSnapshot(), before);
  assert.equal((await f.identity.db.prepare(`UPDATE membership_cards SET redeemed_by=?,redeemed_at=? WHERE code_hash=? AND ${promotionCardRedemptionCondition}`).bind("racy", NOW, card.hash, "racy").run()).meta.changes, 0);
});

test("HTTP redemption ignores forged owner/userId fields and checks the authenticated unrelated account", async t => {
  const f = await fixture(t); f.invite("eligible"); const card = await f.restricted(), before = f.redemptionSnapshot();
  const origin = "https://writing.example";
  const cookie = (await createSession(new Request(origin), f.env, "outsider")).split(";")[0];
  for (const env of [f.env, f.other]) {
    const request = new Request(origin + "/api/membership/redeem", { method: "POST", headers: { origin, cookie, "content-type": "application/json" }, body: JSON.stringify({ code: card.code, owner: "eligible", userId: "eligible" }) });
    await assert.rejects(membershipRoute(request, env), status(403));
    assert.deepEqual(f.redemptionSnapshot(), before);
  }
});
