import { test } from "node:test";
import assert from "node:assert/strict";
import { sqliteDatabase } from "../server/database";
import { EARLY_MEMBER_CUTOFF, ensureMembership, membershipStatus, reconcileEarlyMemberGifts, registrationMembershipStatements } from "../worker/membership";
import type { Env } from "../worker/types";

const CODE = "65F2B48E76", DAY = 86400_000, launch = Date.parse(EARLY_MEMBER_CUTOFF), before = launch - 10000;
function fixture(t: { after: (fn: () => void) => void }) {
  const identity = sqliteDatabase(":memory:"), site = sqliteDatabase(":memory:");
  t.after(() => { identity.sql.close(); site.sql.close(); });
  const env = { DB: site.db, AUTH_DB: identity.db, MEMBERSHIP_ENABLED: "true", MEMBERSHIP_SITE: "cet", MEMBERSHIP_LAUNCH_AT: EARLY_MEMBER_CUTOFF } as Env;
  const other = { ...env, MEMBERSHIP_SITE: "ielts" };
  const user = (id: string) => identity.sql.prepare("INSERT INTO users(id,name,email,password,created_at) VALUES(?,?,?,?,?)").run(id, id, `${id}@example.test`, "!test", new Date(before).toISOString());
  const register = async (id: string, at = before, code = CODE) => {
    const statements = await registrationMembershipStatements(env, id, code, at);
    await identity.db.batch([identity.db.prepare("INSERT INTO users(id,name,email,password,created_at) VALUES(?,?,?,?,?)").bind(id, id, `${id}@example.test`, "!test", new Date(at).toISOString()), ...statements]);
  };
  const setup = async () => {
    user("momo"); await membershipStatus(env, "momo", before);
    identity.sql.prepare("UPDATE membership_accounts SET referral_code=? WHERE user_id='momo'").run(CODE);
    identity.sql.prepare("INSERT INTO membership_referral_campaigns VALUES('momo',?,30,?)").run(CODE, before);
    identity.sql.prepare("INSERT INTO membership_settings VALUES('early_member_gift_mode','total')").run();
  };
  const enable = () => identity.sql.prepare("INSERT INTO membership_referral_permanent_campaigns VALUES('momo',?,?)").run(CODE, before);
  return { identity, env, other, user, register, setup, enable };
}

test("momo's current permanent invitation takes priority over thirty-day, welcome and early-user gifts", async t => {
  const f = fixture(t); await f.setup(); f.enable();
  await f.register("before"); await f.register("after", launch + 1);
  for (const id of ["before", "after"]) {
    const account = (await membershipStatus(f.other, id, launch + 36500 * DAY)).account!;
    assert.equal(account.permanent, true); assert.equal(account.active, true); assert.equal(account.expiresAt, null); assert.equal(account.trialRemaining, 0);
    assert.equal(f.identity.sql.prepare("SELECT expires_at FROM membership_accounts WHERE user_id=?").get(id)!.expires_at, 0);
    assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM membership_events WHERE user_id=?").get(id)!.n, 0);
  }
  const offer = (await membershipStatus(f.env, "momo", before)).account!;
  assert.equal(offer.referralOfferPermanent, true); assert.equal(offer.referralOfferDays, 30); assert.equal(offer.referralCode, CODE);
  assert.equal(f.identity.sql.prepare("SELECT outcome FROM membership_early_gifts WHERE user_id='before'").get()!.outcome, "permanent");
  await f.identity.db.batch(await registrationMembershipStatements(f.other, "before", CODE, before + 1));
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM membership_referral_permanent_grants WHERE invitee_id='before'").get()!.n, 1);
});

test("enabling the permanent offer does not silently upgrade historical thirty-day invitees", async t => {
  const f = fixture(t); await f.setup(); await f.register("historical");
  const original = (await membershipStatus(f.env, "historical", before)).account!.expiresAt;
  f.enable(); await reconcileEarlyMemberGifts(f.env, before);
  await f.identity.db.batch(await registrationMembershipStatements(f.env, "historical", CODE, before + 1));
  const account = (await membershipStatus(f.other, "historical", before)).account!;
  assert.equal(account.permanent, false); assert.equal(account.expiresAt, original);
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM membership_referral_permanent_grants WHERE invitee_id='historical'").get()!.n, 0);
});

test("current-code validation prevents retired or concurrently rotated codes receiving permanent VIP", async t => {
  const f = fixture(t); await f.setup(); f.enable();
  const inFlight = await registrationMembershipStatements(f.env, "in-flight", CODE, before);
  f.identity.sql.prepare("UPDATE membership_accounts SET referral_code='OTHERNEW12' WHERE user_id='momo'").run();
  await assert.rejects(registrationMembershipStatements(f.env, "invalid", CODE, before), /邀请码无效/);
  f.user("in-flight"); await f.identity.db.batch(inFlight);
  assert.equal((await membershipStatus(f.env, "in-flight", before)).account!.permanent, false);
  assert.equal((await membershipStatus(f.env, "momo", before)).account!.referralOfferPermanent, false);
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM membership_referral_permanent_grants").get()!.n, 0);
});

test("ordinary users and other invitation codes retain their one-day registration gift after cutoff", async t => {
  const f = fixture(t); await f.setup(); f.enable(); f.user("ordinary-inviter");
  const code = (await membershipStatus(f.env, "ordinary-inviter", before)).account!.referralCode;
  await f.register("ordinary", launch + 1, code); await f.register("uninvited", launch + 1, "");
  for (const id of ["ordinary", "uninvited"]) {
    const account = (await membershipStatus(f.other, id, launch + 1)).account!;
    assert.equal(account.permanent, false); assert.equal(account.expiresAt, launch + 1 + DAY);
  }
  assert.equal((await membershipStatus(f.env, "ordinary-inviter", before)).account!.referralOfferPermanent, false);
});

test("the campaign's effective timestamp excludes earlier registrations even without an older gift event", async t => {
  const f = fixture(t); await f.setup(); f.enable();
  f.identity.sql.prepare("UPDATE membership_referral_permanent_campaigns SET created_at=? WHERE inviter_id='momo'").run(before + 1000);
  await f.register("just-before", before + 999);
  await f.register("at-effective", before + 1000);
  assert.equal((await membershipStatus(f.env, "just-before", before + 1000)).account!.permanent, false);
  assert.equal((await membershipStatus(f.other, "at-effective", before + 1000)).account!.permanent, true);
});
