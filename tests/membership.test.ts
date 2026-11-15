import { test } from "node:test";
import assert from "node:assert/strict";
import { sqliteDatabase } from "../server/database";
import worker from "../worker/index";
import { createSession } from "../worker/auth";
import { ensureMembership, registrationMembershipStatements, membershipStatus, reserveMembershipReview, finishMembershipReview, createMembershipCards, redeemMembership, reconcileMembershipUsage, memberDay } from "../worker/membership";
import type { Env } from "../worker/types";
import { beginReview, finishReview } from "../worker/repository";
import { questions } from "../src/lib/content";
import type { EssayInput, Feedback } from "../src/lib/types";

const DAY = 86400_000;
const now = new Date("2026-10-31T01:00:00.000Z").getTime();
function fixture(t: { after: (fn: () => void) => void }) {
  const identity = sqliteDatabase(":memory:"), a = sqliteDatabase(":memory:"), b = sqliteDatabase(":memory:");
  t.after(() => { a.sql.close(); b.sql.close(); identity.sql.close(); });
  const env = { DB: a.db, AUTH_DB: identity.db, ASSETS: { fetch: async () => new Response("asset") }, MEMBERSHIP_ENABLED: "true", MEMBERSHIP_SITE: "ielts" } as Env;
  const other = { ...env, DB: b.db, MEMBERSHIP_SITE: "cet" } as Env;
  const user = (id: string) => {
    for (const db of [identity.sql, a.sql, b.sql]) db.prepare("INSERT INTO users(id,name,email,password,created_at) VALUES(?,?,?,?,?)").run(id, id, id + "@example.test", "!test", new Date(now).toISOString());
  };
  return { identity, a, b, env, other, user };
}
const key = () => crypto.randomUUID();
async function admin(f: ReturnType<typeof fixture>, id = "admin") {
  f.user(id); await ensureMembership(f.env);
  f.identity.sql.prepare("INSERT INTO membership_admins(user_id) VALUES(?)").run(id);
  return id;
}

test("registration grants no extra trial attempts and binds the inviter; only the first paid-card redemption rewards them", async t => {
  const f = fixture(t); f.user("inviter");
  const invitation = (await membershipStatus(f.env, "inviter", now)).account!.referralCode;
  const statements = await registrationMembershipStatements(f.env, "new", invitation, now);
  await f.identity.db.batch([f.identity.db.prepare("INSERT INTO users(id,name,email,password,created_at) VALUES('new','New','new@example.test','!test',?)").bind(new Date(now).toISOString()), ...statements]);
  assert.equal((await membershipStatus(f.other, "new", now)).account!.trialRemaining, 0);
  assert.equal((await membershipStatus(f.env, "inviter", now)).account!.expiresAt, null);
  assert.equal((await membershipStatus(f.other, "inviter", now)).account!.invited, 1);
  await assert.rejects(registrationMembershipStatements(f.env, "bad", "NOTFOUND", now), /邀请码无效/);
  const duplicate = await registrationMembershipStatements(f.env, "duplicate", invitation, now);
  await assert.rejects(f.identity.db.batch([f.identity.db.prepare("INSERT INTO users(id,name,email,password,created_at) VALUES('duplicate','X','new@example.test','!test',?)").bind(new Date(now).toISOString()), ...duplicate]));
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM membership_invites").get()!.n, 1);
  assert.equal((await membershipStatus(f.env, "inviter", now)).account!.expiresAt, null);
  await admin(f);
  const week=await createMembershipCards(f.env,"admin",1,"first purchase",now,7);
  await redeemMembership(f.other,"new",week.codes[0],now);
  assert.equal((await membershipStatus(f.env,"inviter",now)).account!.expiresAt,now+3*DAY);
  assert.equal((await membershipStatus(f.other,"inviter",now)).account!.rewardedInvites,1);
  await redeemMembership(f.env,"new",week.codes[0],now+1000);
  const renewal=await createMembershipCards(f.env,"admin",1,"renewal",now,30);
  await redeemMembership(f.env,"new",renewal.codes[0],now+1000);
  assert.equal((await membershipStatus(f.env,"inviter",now)).account!.expiresAt,now+3*DAY);
});

test("a gift card never counts as a paid purchase or triggers an inviter reward",async t=>{
  const f=fixture(t);await admin(f);f.user("inviter");
  const code=(await membershipStatus(f.env,"inviter",now)).account!.referralCode;
  const statements=await registrationMembershipStatements(f.env,"friend",code,now);
  await f.identity.db.batch([f.identity.db.prepare("INSERT INTO users(id,name,email,password,created_at) VALUES('friend','Friend','friend@example.test','!test',?)").bind(new Date(now).toISOString()),...statements]);
  const gift=await createMembershipCards(f.env,"admin",1,"gift",now,7,"gift");
  await redeemMembership(f.env,"friend",gift.codes[0],now);
  assert.equal((await membershipStatus(f.env,"inviter",now)).account!.expiresAt,null);
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM membership_first_payments").get()!.n,0);
  const paid=await createMembershipCards(f.env,"admin",1,"paid",now,7,"sale");
  await redeemMembership(f.other,"friend",paid.codes[0],now);
  assert.equal((await membershipStatus(f.env,"inviter",now)).account!.expiresAt,now+3*DAY);
});

test("historical five-trial balance is preserved, shared across sites, and used after the daily allowance", async t => {
  const f = fixture(t); f.user("learner"); await ensureMembership(f.env);
  f.identity.sql.prepare("INSERT INTO membership_accounts(user_id,trial_granted,referral_code) VALUES('learner',5,'0123456789')").run();
  assert.equal((await membershipStatus(f.other, "learner", now)).account!.trialRemaining, 5);
  for (let i = 0; i < 6; i++) {
    const env = i % 2 ? f.other : f.env, review = key();
    await reserveMembershipReview(env, "learner", key(), review, now);
    await finishMembershipReview(env, "learner", review, true, now);
  }
  const state = (await membershipStatus(f.other, "learner", now)).account!;
  assert.equal(state.dailyRemaining, 0); assert.equal(state.trialRemaining, 0);
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM membership_usage WHERE source='daily'").get()!.n, 1);
  await assert.rejects(reserveMembershipReview(f.other, "learner", key(), key(), now), /免费批改和试用次数已用完/);
  await reserveMembershipReview(f.other, "learner", key(), key(), now + DAY);
  assert.equal(memberDay(new Date("2026-10-31T15:59:59Z").getTime()), "2026-10-31");
  assert.equal(memberDay(new Date("2026-10-31T16:00:00Z").getTime()), "2026-11-01");
});

test("concurrent cross-site requests cannot spend the same daily allowance twice", async t => {
  const f = fixture(t); f.user("learner");
  const results = await Promise.allSettled([reserveMembershipReview(f.env, "learner", key(), key(), now), reserveMembershipReview(f.other, "learner", key(), key(), now)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM membership_usage WHERE status='reserved'").get()!.n, 1);
});

test("failed reviews restore the allowance and completed requests remain idempotent", async t => {
  const f = fixture(t); f.user("learner"); const request = key(), review = key();
  await reserveMembershipReview(f.env, "learner", request, review, now);
  await reserveMembershipReview(f.env, "learner", request, review, now);
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM membership_usage").get()!.n, 1);
  await finishMembershipReview(f.env, "learner", review, false, now);
  assert.equal((await membershipStatus(f.other, "learner", now)).account!.dailyRemaining, 1);
  await reserveMembershipReview(f.other, "learner", key(), key(), now);
  assert.equal((await membershipStatus(f.env, "learner", now)).account!.dailyRemaining, 0);
});

test("reconciliation repairs crashes after saving a report and releases orphaned reservations", async t => {
  const f = fixture(t); f.user("learner"); const review = key();
  await reserveMembershipReview(f.env, "learner", key(), review, now);
  f.a.sql.prepare("INSERT INTO reviews(id,user_id,input,question,status,model,refs,request_key,created_at) VALUES(?,?,'{}','{}','completed','test','[]',?,?)").run(review,"learner",key(),new Date(now).toISOString());
  await reconcileMembershipUsage(f.env, "learner", now + 1000);
  assert.equal(f.identity.sql.prepare("SELECT status FROM membership_usage WHERE review_id=?").get(review)!.status, "completed");
  const orphan = key(); await reserveMembershipReview(f.other, "learner", key(), orphan, now + DAY);
  await reconcileMembershipUsage(f.other, "learner", now + DAY + 121000);
  assert.equal(f.identity.sql.prepare("SELECT status FROM membership_usage WHERE review_id=?").get(orphan)!.status, "released");
});

test("weekly and monthly cards stack, are shared by both sites, and cannot be redeemed twice", async t => {
  const f = fixture(t); await admin(f); f.user("learner"); f.user("other");
  const week = await createMembershipCards(f.env, "admin", 1, "week", now, 7);
  const month = await createMembershipCards(f.env, "admin", 1, "month", now, 30);
  const first = await redeemMembership(f.env, "learner", week.codes[0], now);
  assert.equal(first.alreadyRedeemed, false); assert.equal(first.account!.expiresAt, now + 7 * DAY);
  const repeated = await redeemMembership(f.other, "learner", week.codes[0].toLowerCase(), now + 1000);
  assert.equal(repeated.alreadyRedeemed, true); assert.equal(repeated.account!.expiresAt, now + 7 * DAY);
  const second = await redeemMembership(f.other, "learner", month.codes[0], now);
  assert.equal(second.account!.expiresAt, now + 37 * DAY);
  await assert.rejects(redeemMembership(f.env, "other", week.codes[0], now), /无效或已使用/);
  assert.equal((await membershipStatus(f.env, "learner", now)).account!.expiresAt, now + 37 * DAY);
  assert.doesNotMatch(JSON.stringify(f.identity.sql.prepare("SELECT * FROM membership_cards").all()), /YY-/);
});

test("simultaneous redemptions by two accounts award only one membership", async t => {
  const f = fixture(t); await admin(f); f.user("one"); f.user("two");
  const card = (await createMembershipCards(f.env, "admin", 1, "concurrency", now)).codes[0];
  const results = await Promise.allSettled([redeemMembership(f.env,"one",card,now),redeemMembership(f.other,"two",card,now)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM membership_events WHERE reason='card'").get()!.n,1);
});

test("members have no daily review count cap and expiration takes effect without changing login", async t => {
  const f = fixture(t); await admin(f); f.user("learner");
  await redeemMembership(f.env,"learner",(await createMembershipCards(f.env,"admin",1,"member",now)).codes[0],now);
  for(let i=0;i<35;i++) { const review=key();await reserveMembershipReview(i%2?f.env:f.other,"learner",key(),review,now);await finishMembershipReview(i%2?f.env:f.other,"learner",review,true,now); }
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM membership_usage WHERE source='member'").get()!.n,35);
  const expired = (await membershipStatus(f.other,"learner",now+30*DAY)).account!;
  assert.equal(expired.active,false);assert.equal(expired.dailyRemaining,1);
});

test("card issuance requires administrator authorization; invalid batches leave no cards",async t=>{
  const f=fixture(t);await admin(f);f.user("learner");
  await assert.rejects(createMembershipCards(f.env,"learner",1,"bad",now),/没有卡密管理权限/);
  for(const quantity of [0,-1,201,1.5])await assert.rejects(createMembershipCards(f.env,"admin",quantity,"bad",now));
  await assert.rejects(createMembershipCards(f.env,"admin",1,"bad",now,365));
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM membership_cards").get()!.n,0);
});

test("membership HTTP endpoints protect private data, origin checks, and canonical card durations",async t=>{
  const f=fixture(t);await admin(f);f.user("learner");
  const origin="https://writing.example";
  const cookie=await createSession(new Request(origin),f.env,"learner");
  const publicResponse=await worker.fetch(new Request(origin+"/api/membership"),f.env);
  const publicData=await publicResponse.json();assert.equal(publicData.account,null);assert.deepEqual(publicData.plans.map((p:{price:number;days:number})=>[p.price,p.days]),[[3.9,7],[9.9,30]]);
  const request=(path:string,body:unknown,requestOrigin=origin)=>new Request(origin+path,{method:"POST",headers:{Cookie:cookie.split(";")[0],Origin:requestOrigin,"Content-Type":"application/json"},body:JSON.stringify(body)});
  assert.equal((await worker.fetch(request("/api/membership/cards",{quantity:1}),f.env)).status,403);
  const card=(await createMembershipCards(f.env,"admin",1,"test",now,7)).codes[0];
  assert.equal((await worker.fetch(request("/api/membership/redeem",{code:card},"https://other.example"),f.env)).status,403);
  const good=await worker.fetch(request("/api/membership/redeem",{code:card,days:3650,userId:"admin"}),f.env);
  assert.equal(good.status,200);const data=await good.json();assert.equal(data.account.active,true);
  const event=f.identity.sql.prepare("SELECT user_id,days FROM membership_events WHERE reason='card'").get()!;assert.equal(event.user_id,"learner");assert.equal(event.days,7);
});

test("the real review repository enforces the shared free allowance and bypasses the old daily cap for members",async t=>{
  const f=fixture(t);await admin(f);f.user("learner");
  const question=questions().find(q=>["writing","Task 2"].includes(q.task))!;
  const input={questionId:question.id,essay:"An original synthetic answer with enough content for the repository fixture.",targetBand:7,targetScore:11,title:"Synthetic"} as EssayInput;
  const feedback={overallBand:6,holisticScore:11,assessmentScope:"full"} as unknown as Feedback;
  const requestKey=key();
  const first=await beginReview(f.env,"learner",input,requestKey,"test");
  await finishReview(f.env,"learner",first.review.id,feedback);
  assert.equal((await beginReview(f.env,"learner",input,requestKey,"test")).created,false);
  await assert.rejects(beginReview(f.other,"learner",input,key(),"test"),/免费批改和试用次数已用完/);
  await redeemMembership(f.env,"learner",(await createMembershipCards(f.env,"admin",1,"week",Date.now(),7)).codes[0]);
  for(let i=0;i<18;i++) {
    const env={...(i%2?f.env:f.other),DAILY_REVIEW_LIMIT:"1"};
    const started=await beginReview(env,"learner",{...input,essay:input.essay+" "+i},key(),"test");
    await finishReview(env,"learner",started.review.id,feedback);
  }
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM membership_usage WHERE source='member' AND status='completed'").get()!.n,18);
});

test("a scheduled membership launch still requires ready sales",async t=>{
  const f=fixture(t);await admin(f);f.user("learner");
  const launch=Date.parse("2026-11-02T00:00:00+08:00");
  const env={...f.env,MEMBERSHIP_REQUIRE_READY:"true",MEMBERSHIP_LAUNCH_AT:"2026-11-02T00:00:00+08:00"};
  const code=(await createMembershipCards(env,"admin",1,"scheduled",launch-1000,7)).codes[0];
  f.identity.sql.prepare("INSERT INTO membership_settings(key,value) VALUES('sales_ready','1')").run();
  const before=await membershipStatus(env,"learner",launch-1);
  assert.equal(before.launchPending,true);assert.equal(before.accessEnabled,false);
  assert.equal(before.plans.every(p=>!p.available),true);
  await reserveMembershipReview(env,"learner",key(),key(),launch-1);
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM membership_usage").get()!.n,0);
  await assert.rejects(redeemMembership(env,"learner",code,launch-1),/会员尚未上线/);
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM membership_events").get()!.n,0);
  const after=await membershipStatus(env,"learner",launch);
  assert.equal(after.launchPending,false);assert.equal(after.accessEnabled,true);
  await reserveMembershipReview(env,"learner",key(),key(),launch);
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM membership_usage").get()!.n,1);
  await assert.rejects(reserveMembershipReview(env,"learner",key(),key(),launch),/免费批改和试用次数已用完/);
  assert.equal((await redeemMembership(env,"learner",code,launch)).account!.expiresAt,launch+7*DAY);
  f.identity.sql.prepare("UPDATE membership_settings SET value='0' WHERE key='sales_ready'").run();
  assert.equal((await membershipStatus(env,undefined,launch)).accessEnabled,false);
});

test("a deferred launch stays free after the old date and leaves cards and allowances untouched",async t=>{
  const f=fixture(t);await admin(f);f.user("learner");
  const env={...f.env,MEMBERSHIP_REQUIRE_READY:"true",MEMBERSHIP_LAUNCH_AT:"2026-11-02T00:00:00+08:00",MEMBERSHIP_LAUNCH_DEFERRED:"true"};
  f.identity.sql.prepare("INSERT INTO membership_settings(key,value) VALUES('sales_ready','1')").run();
  const code=(await createMembershipCards(env,"admin",1,"deferred",Date.now(),7)).codes[0];
  for(const now of [Date.parse("2026-11-02T00:00:00+08:00"),Date.parse("2027-01-01T00:00:00+08:00")]) {
    const status=await membershipStatus(env,"learner",now);
    assert.equal(status.launchDeferred,true);assert.equal(status.launchPending,true);assert.equal(status.accessEnabled,false);
    assert.equal(status.plans.every(plan=>!plan.available),true);
    for(let i=0;i<3;i++)await reserveMembershipReview(env,"learner",key(),key(),now);
    await assert.rejects(redeemMembership(env,"learner",code,now),/具体时间另行通知/);
  }
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM membership_usage").get()!.n,0);
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM membership_events").get()!.n,0);
  assert.equal(f.identity.sql.prepare("SELECT redeemed_at FROM membership_cards").get()!.redeemed_at,null);
  assert.equal((await membershipStatus({...env,MEMBERSHIP_LAUNCH_DEFERRED:"false"},"learner",Date.parse("2027-01-01T00:00:00+08:00"))).accessEnabled,true);
});

test("new free limits remain inactive until the purchase channel is ready",async t=>{
  const f=fixture(t);f.user("learner");const env={...f.env,MEMBERSHIP_REQUIRE_READY:"true"};
  const question=questions().find(q=>["writing","Task 2"].includes(q.task))!;
  const input={questionId:question.id,essay:"Synthetic readiness answer.",targetBand:7,targetScore:11,title:"Readiness"} as EssayInput;
  const feedback={overallBand:6,holisticScore:11,assessmentScope:"full"} as unknown as Feedback;
  assert.equal((await membershipStatus(env,"learner")).accessEnabled,false);
  for(let i=0;i<2;i++){const result=await beginReview(env,"learner",input,key(),"test");await finishReview(env,"learner",result.review.id,feedback);}
  assert.equal(f.identity.sql.prepare("SELECT COUNT(*) n FROM membership_usage").get()!.n,0);
  f.identity.sql.prepare("INSERT INTO membership_settings(key,value) VALUES('sales_ready','1')").run();
  assert.equal((await membershipStatus(env,"learner")).accessEnabled,true);
  const result=await beginReview(env,"learner",input,key(),"test");await finishReview(env,"learner",result.review.id,feedback);
  await assert.rejects(beginReview(env,"learner",input,key(),"test"),/免费批改和试用次数已用完/);
});

