import { test } from "node:test";
import assert from "node:assert/strict";
import { sqliteDatabase } from "../server/database";
import worker from "../worker/index";
import { digest, SESSION_AGE_SECONDS } from "../worker/auth";
import { ApiError, createApiClient } from "../src/lib/api-client";

const COOKIE = "cet_session";
test("valid existing cookies renew for thirty days, refresh once per day, and logout remains final", async t => {
  const {sql,db}=sqliteDatabase(":memory:");t.after(()=>sql.close());
  const now=Date.now(),token="c".repeat(64),hash=await digest(token);
  sql.prepare("INSERT INTO users(id,name,email,password,created_at) VALUES(?,?,?,?,?)").run("learner","Learner","learner@example.test","!test",new Date().toISOString());
  sql.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)").run(hash,"learner",now+14*86400_000);
  const env={DB:db,ASSETS:{fetch:async()=>new Response("asset")}};
  const request=(path:string,method="GET",body?:object)=>new Request("https://writing.example"+path,{method,headers:{Cookie:COOKIE+"="+token,Origin:"https://writing.example","Content-Type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});
  const first=await worker.fetch(request("/api/auth"),env);
  assert.equal((await first.json()).user.id,"learner");
  assert.match(first.headers.get("set-cookie")!,new RegExp(`^${COOKIE}=${token};`));
  assert.match(first.headers.get("set-cookie")!,/HttpOnly; SameSite=Lax; Max-Age=2592000; Expires=[^;]+; Secure/);
  assert.ok(Number(sql.prepare("SELECT expires_at FROM sessions WHERE token_hash=?").get(hash)!.expires_at)>=now+SESSION_AGE_SECONDS*1000);
  const expiry=sql.prepare("SELECT expires_at FROM sessions WHERE token_hash=?").get(hash)!.expires_at;
  const refreshed=await worker.fetch(request("/api/auth"),env);
  assert.match(refreshed.headers.get("set-cookie")!, /Expires=[^;]+; Secure/);
  assert.ok(Number(refreshed.headers.get("set-cookie")!.match(/Max-Age=(\d+)/)![1]) >= SESSION_AGE_SECONDS - 60);
  assert.equal(sql.prepare("SELECT expires_at FROM sessions WHERE token_hash=?").get(hash)!.expires_at,expiry);
  const restoredCookie=refreshed.headers.get("set-cookie")!.split(";")[0];
  const reopened=await worker.fetch(new Request("https://writing.example/api/auth",{headers:{Cookie:restoredCookie}}),env);
  assert.equal((await reopened.json()).user.id,"learner");
  const logout=await worker.fetch(request("/api/auth","POST",{action:"logout"}),env);
  assert.match(logout.headers.get("set-cookie")!,/Max-Age=0/);
  assert.equal((await (await worker.fetch(request("/api/auth"),env)).json()).user,null);
  assert.equal(sql.prepare("SELECT count(*) AS n FROM sessions").get()!.n,0);
  sql.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)").run(hash,"learner",now-1);
  const expired=await worker.fetch(request("/api/auth"),env);assert.equal((await expired.json()).user,null);assert.equal(expired.headers.get("set-cookie"),null);
});

test("stale unauthorized requests retry a live session without sending a false logout event",async()=>{
  const oldFetch=globalThis.fetch,oldWindow=Object.getOwnPropertyDescriptor(globalThis,"window");
  const events=new EventTarget();Object.defineProperty(globalThis,"window",{value:events,configurable:true});
  let expired=0,privateCalls=0,checks=0;events.addEventListener("test:expired",()=>expired++);
  const client=createApiClient("test:expired");
  globalThis.fetch=(async(url,options)=>{
    assert.equal(options?.credentials,"same-origin");
    if(String(url)==="/api/auth"){checks++;return Response.json({user:{id:"current"}});}
    privateCalls++;return privateCalls===1?Response.json({error:"Old request",code:"LOGIN_REQUIRED"},{status:401}):Response.json({saved:true});
  }) as typeof fetch;
  try {assert.deepEqual(await client("/api/drafts",{method:"POST",body:'{"requestKey":"same"}'}),{saved:true});assert.equal(expired,0);assert.equal(checks,1);assert.equal(privateCalls,2);}
  finally{globalThis.fetch=oldFetch;if(oldWindow)Object.defineProperty(globalThis,"window",oldWindow);else Reflect.deleteProperty(globalThis,"window");}
});

test("unreachable session checks and provider authorization errors do not log the user out",async()=>{
  const oldFetch=globalThis.fetch,oldWindow=Object.getOwnPropertyDescriptor(globalThis,"window");const events=new EventTarget();Object.defineProperty(globalThis,"window",{value:events,configurable:true});
  let expired=0;events.addEventListener("test:expired",()=>expired++);const client=createApiClient("test:expired");
  try {
    globalThis.fetch=(async url=>{if(String(url)==="/api/auth")throw new Error("offline");return Response.json({error:"Unauthorized",code:"LOGIN_REQUIRED"},{status:401});}) as typeof fetch;
    await assert.rejects(client("/api/drafts"),e=>e instanceof ApiError&&e.status===401);assert.equal(expired,0);
    globalThis.fetch=(async url=>{assert.notEqual(String(url),"/api/auth");return Response.json({error:"Provider key",code:"PROVIDER_AUTH"},{status:401});}) as typeof fetch;
    await assert.rejects(client("/api/reviews"),e=>e instanceof ApiError&&e.status===401);assert.equal(expired,0);
    globalThis.fetch=(async url=>String(url)==="/api/auth"?Response.json({user:null}):Response.json({error:"Expired",code:"LOGIN_REQUIRED"},{status:401})) as typeof fetch;
    await assert.rejects(client("/api/drafts"));assert.equal(expired,1);
  }finally{globalThis.fetch=oldFetch;if(oldWindow)Object.defineProperty(globalThis,"window",oldWindow);else Reflect.deleteProperty(globalThis,"window");}
});

