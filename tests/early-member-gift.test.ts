import { test } from "node:test";
import assert from "node:assert/strict";
import { sqliteDatabase } from "../server/database";
import { EARLY_MEMBER_CUTOFF, ensureMembership, membershipStatus, reconcileEarlyMemberGifts, registrationMembershipStatements } from "../worker/membership";
import type { Env } from "../worker/types";

const DAY = 86400_000, launch = Date.parse(EARLY_MEMBER_CUTOFF), before = launch - 60000;
function fixture(t: { after: (fn: () => void) => void }) {
  const identity = sqliteDatabase(":memory:"), site = sqliteDatabase(":memory:");
  t.after(() => { identity.sql.close(); site.sql.close(); });
  const env = { DB: site.db, AUTH_DB: identity.db, MEMBERSHIP_ENABLED: "true", MEMBERSHIP_LAUNCH_AT: EARLY_MEMBER_CUTOFF, MEMBERSHIP_SITE: "cet" } as Env;
  const other = { ...env, MEMBERSHIP_SITE: "ielts" };
  const user = (id: string, createdAt = new Date(before).toISOString()) => identity.sql.prepare("INSERT INTO users(id,name,email,password,created_at) VALUES(?,?,?,?,?)").run(id, id, id + "@example.test", "!test", createdAt);
  const mode = async (value: "total") => { await ensureMembership(env); identity.sql.prepare("INSERT INTO membership_settings(key,value) VALUES('early_member_gift_mode',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(value); };
  const register = async (id: string, at: number, code = "") => {
    const statements = await registrationMembershipStatements(env, id, code, at);
    await identity.db.batch([identity.db.prepare("INSERT INTO users(id,name,email,password,created_at) VALUES(?,?,?,?,?)").bind(id, id, id + "@example.test", "!test", new Date(at).toISOString()), ...statements]);
  };
  const campaign = async () => {
    user("momo"); const code = (await membershipStatus(env, "momo", before)).account!.referralCode;
    identity.sql.prepare("INSERT INTO membership_referral_campaigns VALUES('momo',?,30,?)").run(code, before);
    return code;
  };
  return { identity, env, other, user, mode, register, campaign };
}

test("an unconfirmed early-user mode stays disabled and keeps the ordinary one-day gift", async t => {
  const f = fixture(t); await f.register("new", before);
  await reconcileEarlyMemberGifts(f.env, before);
  assert.equal((await membershipStatus(f.env, "new", before)).account!.expiresAt, launch + DAY);
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM membership_early_gifts").get()!.n, 0);
});

test("total mode grants ordinary users five days and preserves special gifts only before the strict cutoff", async t => {
  const f = fixture(t); await f.mode("total"); const code = await f.campaign();
  await f.register("early", launch - 1);
  await f.register("special", launch - 1, code);
  await f.register("at-cutoff", launch);
  await f.register("after", launch + 1);
  await f.register("special-after", launch + 1, code);
  assert.equal((await membershipStatus(f.other, "early", before)).account!.expiresAt, launch + 5 * DAY);
  assert.equal((await membershipStatus(f.other, "special", before)).account!.expiresAt, launch + 30 * DAY);
  assert.equal((await membershipStatus(f.env, "at-cutoff", launch)).account!.expiresAt, launch + DAY);
  assert.equal((await membershipStatus(f.env, "after", launch + 1)).account!.expiresAt, launch + 1 + DAY);
  assert.equal((await membershipStatus(f.env, "special-after", launch + 1)).account!.expiresAt, launch + 1 + 30 * DAY);
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM membership_early_gifts").get()!.n, 2);
  assert.equal((await membershipStatus(f.env, "early", before)).account!.trialRemaining, 0);
});

test("total mode tops ordinary gifts up to five days while preserving dedicated thirty-day gifts", async t => {
  const f = fixture(t); await f.mode("total"); const code = await f.campaign();
  await f.register("early", before); await f.register("special", before, code);
  assert.equal((await membershipStatus(f.env, "early", before)).account!.expiresAt, launch + 5 * DAY);
  assert.equal((await membershipStatus(f.env, "special", before)).account!.expiresAt, launch + 30 * DAY);
  assert.equal(f.identity.sql.prepare("SELECT days FROM membership_early_gifts WHERE user_id='early'").get()!.days, 4);
  assert.equal(f.identity.sql.prepare("SELECT outcome FROM membership_early_gifts WHERE user_id='special'").get()!.outcome, "covered");
});

test("repair reaches every early shared account, preserves paid time and historical trials, and is concurrent-safe", async t => {
  const f = fixture(t); await f.mode("total");
  for (const id of ["old", "paid", "permanent"]) f.user(id);
  await membershipStatus(f.env, "paid", before);
  f.identity.sql.prepare("UPDATE membership_accounts SET expires_at=?,trial_granted=5 WHERE user_id='paid'").run(launch + 40 * DAY);
  f.identity.sql.prepare("INSERT INTO membership_permanent VALUES('permanent',?)").run(before);
  const rowsBefore = f.identity.sql.prepare("SELECT * FROM users ORDER BY id").all();
  await Promise.all([reconcileEarlyMemberGifts(f.env, before), reconcileEarlyMemberGifts(f.other, before)]);
  await reconcileEarlyMemberGifts(f.env, launch + 10 * DAY);
  assert.equal((await membershipStatus(f.env, "old", before)).account!.expiresAt, launch + 5 * DAY);
  assert.equal((await membershipStatus(f.env, "paid", before)).account!.expiresAt, launch + 45 * DAY);
  assert.equal((await membershipStatus(f.env, "paid", before)).account!.trialRemaining, 5);
  assert.equal((await membershipStatus(f.other, "permanent", launch + 100 * DAY)).account!.permanent, true);
  assert.equal(f.identity.sql.prepare("SELECT expires_at FROM membership_accounts WHERE user_id='permanent'").get()!.expires_at, 0);
  assert.equal(f.identity.sql.prepare("SELECT outcome FROM membership_early_gifts WHERE user_id='permanent'").get()!.outcome, "permanent");
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM membership_events WHERE reason='early-member'").get()!.n, 2);
  assert.deepEqual(f.identity.sql.prepare("SELECT * FROM users ORDER BY id").all(), rowsBefore);
});

test("registrations arriving after an initial backfill are still credited until the cutoff, once", async t => {
  const f = fixture(t); await f.mode("total");
  await reconcileEarlyMemberGifts(f.env, before);
  await f.register("later-before-midnight", launch - 1);
  await Promise.all([reconcileEarlyMemberGifts(f.env, launch), reconcileEarlyMemberGifts(f.other, launch)]);
  await f.identity.db.batch(await registrationMembershipStatements(f.other, "later-before-midnight", "", launch + 1));
  assert.equal((await membershipStatus(f.other, "later-before-midnight", launch)).account!.expiresAt, launch + 5 * DAY);
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM membership_events WHERE reason='early-member'").get()!.n, 1);
});

test("a historical two-day welcome gift is topped up by three while paid time is preserved", async t => {
  const f = fixture(t); await f.mode("total"); f.user("old-two");
  await membershipStatus(f.env, "old-two", before);
  const existingPaidAndGiftExpiry = launch + 42 * DAY;
  f.identity.sql.prepare("UPDATE membership_accounts SET expires_at=? WHERE user_id='old-two'").run(existingPaidAndGiftExpiry);
  f.identity.sql.prepare("INSERT INTO membership_events(event_key,user_id,days,reason,created_at,applied_at) VALUES('registration-welcome:old-two','old-two',2,'registration-welcome',?,?)").run(before - DAY, before - DAY);
  await reconcileEarlyMemberGifts(f.env, before);
  assert.equal(f.identity.sql.prepare("SELECT days FROM membership_early_gifts WHERE user_id='old-two'").get()!.days, 3);
  assert.equal((await membershipStatus(f.env, "old-two", before)).account!.expiresAt, existingPaidAndGiftExpiry + 3 * DAY);
  assert.equal(f.identity.sql.prepare("SELECT days FROM membership_events WHERE event_key='registration-welcome:old-two'").get()!.days, 2);
});
