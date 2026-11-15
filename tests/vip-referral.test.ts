import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { sqliteDatabase } from "../server/database";
import { activeMembershipIds, createMembershipCards, ensureMembership, finishMembershipReview, membershipReviewMode, membershipStatus, redeemMembership, registrationMembershipStatements, reserveMembershipReview } from "../worker/membership";
import type { Env } from "../worker/types";

const DAY = 86400_000, now = Date.parse("2026-11-01T12:00:00+08:00");
function fixture(t: { after: (fn: () => void) => void }, path = ":memory:") {
  const identity = sqliteDatabase(path), site = sqliteDatabase(":memory:");
  t.after(() => { identity.sql.close(); site.sql.close(); });
  const env = { DB: site.db, AUTH_DB: identity.db, MEMBERSHIP_ENABLED: "true", MEMBERSHIP_SITE: "cet" } as Env;
  const other = { ...env, MEMBERSHIP_SITE: "ielts" };
  const user = (id: string, name = id) => identity.sql.prepare("INSERT INTO users(id,name,email,password,created_at) VALUES(?,?,?,?,?)").run(id, name, id + "@example.test", "!test", new Date(now).toISOString());
  const register = async (id: string, code: string, at = now, targetEnv = env) => {
    const statements = await registrationMembershipStatements(targetEnv, id, code, at);
    await identity.db.batch([identity.db.prepare("INSERT INTO users(id,name,email,password,created_at) VALUES(?,?,?,?,?)").bind(id, id, id + "@example.test", "!test", new Date(at).toISOString()), ...statements]);
  };
  return { identity, env, other, user, register };
}
async function campaign(f: ReturnType<typeof fixture>) {
  f.user("momo");
  const code = (await membershipStatus(f.env, "momo", now)).account!.referralCode;
  f.identity.sql.prepare("INSERT INTO membership_permanent(user_id,granted_at) VALUES('momo',?)").run(now);
  f.identity.sql.prepare("INSERT INTO membership_referral_campaigns(inviter_id,referral_code,days,created_at) VALUES('momo',?,30,?)").run(code, now);
  return code;
}

test("the dedicated invitation grants a shared thirty-day registration gift once, without a purchase", async t => {
  const f = fixture(t), code = await campaign(f);
  await f.register("friend", code.toLowerCase());
  const member = (await membershipStatus(f.other, "friend", now)).account!;
  assert.equal(member.active, true); assert.equal(member.expiresAt, now + 30 * DAY);
  assert.equal(member.trialRemaining, 0);
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM membership_first_payments").get()!.n, 0);
  assert.equal(member.events[0].reason, "registration-invite");
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM membership_events WHERE user_id='friend' AND reason='registration-welcome'").get()!.n, 0);
  await f.identity.db.batch(await registrationMembershipStatements(f.other, "friend", code, now + 1000));
  assert.equal((await membershipStatus(f.env, "friend", now)).account!.expiresAt, now + 30 * DAY);
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM membership_events WHERE reason='registration-invite'").get()!.n, 1);
  assert.equal((await membershipStatus(f.env, "momo", now)).account!.referralOfferDays, 30);
});

test("gifts registered before the launch retain the full month from launch; later registrations start immediately", async t => {
  const f = fixture(t), code = await campaign(f), launch = Date.parse("2026-11-02T00:00:00+08:00");
  const scheduled = { ...f.env, MEMBERSHIP_LAUNCH_AT: "2026-11-02T00:00:00+08:00" };
  await f.register("early", code, now, scheduled);
  await f.register("later", code, launch + DAY, scheduled);
  assert.equal((await membershipStatus(scheduled, "early", now)).account!.expiresAt, launch + 30 * DAY);
  assert.equal((await membershipStatus(scheduled, "later", launch + DAY)).account!.expiresAt, launch + 31 * DAY);
  assert.equal(await membershipReviewMode(scheduled, "early", launch - 1), "legacy");
  assert.equal(await membershipReviewMode(scheduled, "early", launch), "member");
});

test("ordinary invitations and uninvited registrations get only one-day VIP with no extra trial attempts", async t => {
  const f = fixture(t); f.user("ordinary");
  const code = (await membershipStatus(f.env, "ordinary", now)).account!.referralCode;
  await f.register("friend", code);
  await f.register("uninvited", "");
  for (const id of ["friend", "uninvited"]) {
    const account = (await membershipStatus(f.other, id, now)).account!;
    assert.equal(account.active, true); assert.equal(account.expiresAt, now + DAY);
    assert.equal(account.trialRemaining, 0); assert.equal(account.events[0].reason, "registration-welcome");
  }
  await f.identity.db.batch(await registrationMembershipStatements(f.other, "friend", code, now + 1000));
  assert.equal((await membershipStatus(f.env, "friend", now)).account!.expiresAt, now + DAY);
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM membership_first_payments").get()!.n, 0);
});

test("standard welcome gifts registered before launch retain one full day and never upgrade twice on replay", async t => {
  const f = fixture(t), launch = Date.parse("2026-11-02T00:00:00+08:00");
  const scheduled = { ...f.env, MEMBERSHIP_LAUNCH_AT: "2026-11-02T00:00:00+08:00" };
  await f.register("early", "", now, scheduled);
  assert.equal((await membershipStatus(scheduled, "early", now)).account!.expiresAt, launch + DAY);
  const dedicated = await campaign(f);
  await f.identity.db.batch(await registrationMembershipStatements(scheduled, "early", dedicated, now));
  assert.equal((await membershipStatus(scheduled, "early", now)).account!.expiresAt, launch + DAY);
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM membership_events WHERE user_id='early'").get()!.n, 1);
});

test("after the one-day registration VIP ends, a new account returns to one daily review without extra trials", async t => {
  const f = fixture(t); await f.register("welcome", "");
  const expiry = now + DAY;
  for (let i = 0; i < 3; i++) {
    const review = crypto.randomUUID();
    await reserveMembershipReview(f.env, "welcome", crypto.randomUUID(), review, expiry - 1);
    await finishMembershipReview(f.env, "welcome", review, true, expiry - 1);
  }
  const expired = (await membershipStatus(f.other, "welcome", expiry)).account!;
  assert.equal(expired.active, false); assert.equal(expired.trialRemaining, 0); assert.equal(expired.dailyRemaining, 1);
  const review = crypto.randomUUID();
  await reserveMembershipReview(f.other, "welcome", crypto.randomUUID(), review, expiry);
  await finishMembershipReview(f.other, "welcome", review, true, expiry);
  await assert.rejects(reserveMembershipReview(f.env, "welcome", crypto.randomUUID(), crypto.randomUUID(), expiry), /免费批改和试用次数已用完/);
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM membership_usage WHERE user_id='welcome' AND source='trial'").get()!.n, 0);
  await reserveMembershipReview(f.env, "welcome", crypto.randomUUID(), crypto.randomUUID(), expiry + DAY);
});

test("rotation invalidates the old referral without rewriting historical invitations and blocks stale campaign grants", async t => {
  const f = fixture(t), oldCode = await campaign(f);
  await f.register("history", oldCode);
  const inFlight = await registrationMembershipStatements(f.env, "in-flight", oldCode, now);
  f.identity.sql.prepare("UPDATE membership_accounts SET referral_code='NEWCODE123' WHERE user_id='momo'").run();
  await assert.rejects(registrationMembershipStatements(f.env, "late", oldCode, now), /邀请码无效/);
  f.user("in-flight"); await f.identity.db.batch(inFlight);
  assert.equal((await membershipStatus(f.env, "in-flight", now)).account!.expiresAt, now + DAY);
  assert.equal(f.identity.sql.prepare("SELECT inviter_id FROM membership_invites WHERE invitee_id='history'").get()!.inviter_id, "momo");
  // A campaign tied to a retired code cannot accidentally follow a later rotation.
  await f.register("no-gift", "NEWCODE123");
  assert.equal((await membershipStatus(f.env, "no-gift", now)).account!.expiresAt, now + DAY);
  await assert.rejects(registrationMembershipStatements(f.env, "momo", "NEWCODE123"), /自己的邀请码/);
});

test("registration and its gift remain one transaction when a duplicate email is rejected", async t => {
  const f = fixture(t), code = await campaign(f); f.user("existing");
  const statements = await registrationMembershipStatements(f.env, "duplicate", code, now);
  await assert.rejects(f.identity.db.batch([f.identity.db.prepare("INSERT INTO users(id,name,email,password,created_at) VALUES('duplicate','Duplicate','existing@example.test','!test',?)").bind(new Date(now).toISOString()), ...statements]));
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM membership_events WHERE user_id='duplicate'").get()!.n, 0);
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM membership_invites WHERE invitee_id='duplicate'").get()!.n, 0);
});

test("permanent VIP is explicit, shared, never expires, and does not consume renewal cards or free quota", async t => {
  const f = fixture(t), code = await campaign(f), farFuture = Date.parse("2050-01-01T00:00:00Z");
  const member = (await membershipStatus(f.other, "momo", farFuture)).account!;
  assert.equal(member.permanent, true); assert.equal(member.active, true); assert.equal(member.expiresAt, null);
  assert.equal((await activeMembershipIds(f.env, ["momo"], farFuture)).has("momo"), true);
  assert.equal((await activeMembershipIds({ ...f.env, MEMBERSHIP_ENABLED: "false" }, ["momo"], farFuture)).size, 0);
  for (let i = 0; i < 8; i++) {
    const id = crypto.randomUUID(); await reserveMembershipReview(f.other, "momo", crypto.randomUUID(), id, farFuture); await finishMembershipReview(f.other, "momo", id, true, farFuture);
  }
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM membership_usage WHERE source='member'").get()!.n, 8);
  f.identity.sql.prepare("INSERT INTO membership_admins(user_id) VALUES('momo')").run();
  const card = (await createMembershipCards(f.env, "momo", 1, "synthetic", now, 30)).codes[0];
  await assert.rejects(redeemMembership(f.env, "momo", card, now), /永久VIP/);
  assert.equal(f.identity.sql.prepare("SELECT redeemed_at FROM membership_cards").get()!.redeemed_at, null);
  await f.register("friend", code);
  await redeemMembership(f.other, "friend", card, now);
  assert.equal(f.identity.sql.prepare("SELECT expires_at FROM membership_accounts WHERE user_id='momo'").get()!.expires_at, 0);
  assert.equal((await membershipStatus(f.env, "momo", farFuture)).account!.permanent, true);
});

test("VIP referral provisioning defaults to dry-run and a repeated operation does not rotate twice", async t => {
  const directory = mkdtempSync(join(tmpdir(), "vip-referral-"));
  const path = join(directory, "identity.sqlite"), f = fixture(t, path);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  f.user("momo-id", "momo"); await ensureMembership(f.env);
  const oldCode = (await membershipStatus(f.env, "momo-id", now)).account!.referralCode;
  const script = "scripts/configure-vip-referral.mjs";
  const base = [`--db=${path}`, "--name=momo", "--user-id=momo-id"];
  const run = (extra: string[] = []) => {
    const result = spawnSync(process.execPath, [script, ...base, ...extra], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
  };
  const plan = run(); assert.equal(plan.applied, false);
  assert.equal(f.identity.sql.prepare("SELECT referral_code FROM membership_accounts WHERE user_id='momo-id'").get()!.referral_code, oldCode);
  const options = ["--apply", "--operation-id=synthetic-vip", `--backup-dir=${join(directory, "backups")}`];
  const first = run(options), repeat = run(options);
  assert.notEqual(first.referralCode, oldCode); assert.equal(first.referralCode, repeat.referralCode);
  assert.equal(first.alreadyApplied, false); assert.equal(repeat.alreadyApplied, true);
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM membership_referral_rotations").get()!.n, 1);
  assert.equal(f.identity.sql.prepare("SELECT days FROM membership_referral_campaigns").get()!.days, 30);
});
