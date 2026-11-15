import { test } from "node:test";
import assert from "node:assert/strict";
import { sqliteDatabase } from "../server/database";
import { practiceSentences, sentenceGaps, sentenceTokens, sentenceHintSignature, wordMatches } from "../src/lib/sentence-practice";
import { questions } from "../src/lib/content";
import { completeSentence, sentenceProgress } from "../worker/sentence-practice";
import { createSession } from "../worker/auth";
import { getLeaderboard, getQuestionStats } from "../worker/leaderboard";
import worker from "../worker/index";
import type { Env } from "../worker/types";

function fixture(t: { after: (fn: () => void) => void }) {
  const {db,sql}=sqliteDatabase(":memory:");t.after(()=>sql.close());
  const env={DB:db,ASSETS:{fetch:async()=>new Response("asset")}} as Env;
  for(const id of ["alice","bob"])sql.prepare("INSERT INTO users(id,name,email,password,created_at) VALUES(?,?,?,?,?)").run(id,id,id+"@example.test","!fixture","2026-10-01T00:00:00Z");
  return {env,sql};
}
const first=practiceSentences[0],answers=sentenceGaps(first.english);
const now=new Date("2026-10-31T15:59:59.999Z");
test("all reference sentences support different hint words while retaining every key content word",()=>{
  for(const sentence of practiceSentences){
    const signatures=new Set(Array.from({length:40},(_,i)=>sentenceHintSignature(sentence.english,i.toString(16).padStart(32,"0"))));
    assert.ok(signatures.size>1,sentence.id+" must allow different hint words");
    const seed="1234567890abcdef1234567890abcdef";
    assert.deepEqual(sentenceTokens(sentence.english,seed),sentenceTokens(sentence.english,seed));
    assert.ok(sentenceGaps(sentence.english,seed).length>=3);
  }
});
test("the server grades the current randomized blanks and keeps one lifetime point across hint changes",async t=>{
  const f=fixture(t),seed="1234567890abcdef1234567890abcdef",other="abcdef1234567890abcdef1234567890";
  const firstResult=await completeSentence(f.env,"alice",{sentenceId:first.id,hintSeed:seed,answers:sentenceGaps(first.english,seed)},now);
  assert.equal(firstResult.passed,true);assert.equal(firstResult.awarded,true);
  const retry=await completeSentence(f.env,"alice",{sentenceId:first.id,hintSeed:other,answers:sentenceGaps(first.english,other)},now);
  assert.equal(retry.passed,true);assert.equal(retry.awarded,false);
  assert.equal((await sentenceProgress(f.env,"alice",now)).points,1);
});
test("reference sentences retain the exact question, level and source attribution",()=>{
  const past=practiceSentences.filter(row=>row.corpus==="past");
  assert.equal(past.length,100);
  assert.equal(new Set(practiceSentences.map(row=>row.id)).size,practiceSentences.length);
  const compact=(text:string)=>text.replace(/\s/g,"");
  for(const sentence of practiceSentences){
    const question=questions().find(row=>row.id===sentence.questionId)!;
    assert.ok(question);assert.equal(question.task,"translation");
    assert.equal(question.examType,sentence.examType);assert.equal(question.sourceUrl,sentence.sourceUrl);
    assert.ok(compact(question.sourceText).includes(compact(sentence.chinese)),sentence.id);
    assert.equal(sentenceTokens(sentence.english).map(token=>token.text).join(""),sentence.english);
    const hints=sentenceTokens(sentence.english).filter(token=>token.word&&token.gap===null);
    assert.ok(hints.length>=1&&hints.length<=6);assert.ok(sentenceGaps(sentence.english).length>=3);
  }
  assert.equal(past.filter(row=>row.examType==="CET4").length,50);
  const medical=practiceSentences.find(row=>row.english.startsWith("Artificial"))!;
  assert.ok(sentenceGaps(medical.english).includes("Artificial"));
  assert.equal(wordMatches("China’s","China's"),true);
  assert.equal(wordMatches(" TEACHER ","teacher"),true);
  assert.equal(wordMatches("techer","teacher"),false);
});
test("incomplete, misspelled, unknown and forged extra answers never award points",async t=>{
  const f=fixture(t);
  for(const value of [[],[...answers.slice(1)],["incorrect",...answers.slice(1)],[...answers,"extra"]]){
    assert.equal((await completeSentence(f.env,"alice",{sentenceId:first.id,answers:value},now)).passed,false);
  }
  await assert.rejects(completeSentence(f.env,"alice",{sentenceId:"unknown",answers},now),/暂未收录/);
  assert.equal((await sentenceProgress(f.env,"alice",now)).points,0);
});
test("one first pass per account and sentence survives retries, concurrency and day changes",async t=>{
  const f=fixture(t);
  const data={sentenceId:first.id,answers:answers.map(word=>word.toLowerCase())};
  const result=await Promise.all([completeSentence(f.env,"alice",data,now),completeSentence(f.env,"alice",data,now)]);
  assert.equal(result.filter(row=>row.awarded).length,1);
  assert.equal((await completeSentence(f.env,"alice",data,new Date(now.getTime()+1))).awarded,false);
  const after=await sentenceProgress(f.env,"alice",new Date(now.getTime()+1));
  assert.deepEqual(after,{completed:[first.id],points:1,todayPoints:0});
  assert.equal((await completeSentence(f.env,"bob",data,new Date(now.getTime()+1))).awarded,true);
  assert.equal((await sentenceProgress(f.env,"alice",now)).todayPoints,1);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM translation_sentence_completions").get()!.n,2);
});
test("sentence credits combine with review scores in daily and total boards without changing question means",async t=>{
  const f=fixture(t);
  const q=questions().find(row=>row.task==="translation")!;
  f.sql.prepare("INSERT INTO reviews(id,user_id,input,question,status,feedback,model,refs,request_key,created_at) VALUES('review','alice',?,?,'completed',?,'test','[]','req',?)").run(JSON.stringify({questionId:q.id,essay:"A scored private answer."}),JSON.stringify(q),JSON.stringify({holisticScore:11,assessmentScope:"full"}),now.toISOString());
  await completeSentence(f.env,"alice",{sentenceId:first.id,answers},now);
  await completeSentence(f.env,"bob",{sentenceId:first.id,answers},new Date(now.getTime()+1));
  const request=new Request("https://writing.example/api/leaderboard");
  const before=await getLeaderboard(request,f.env,now);
  assert.equal(before.daily.find(row=>row.name==="alice")?.points,12);
  assert.equal(before.daily.find(row=>row.name==="alice")?.attempts,2);
  assert.equal(before.daily.some(row=>row.name==="bob"),false);
  const after=await getLeaderboard(request,f.env,new Date(now.getTime()+1));
  assert.equal(after.daily.find(row=>row.name==="bob")?.points,1);
  assert.equal(after.total.find(row=>row.name==="alice")?.points,12);
  assert.equal(after.total.find(row=>row.name==="bob")?.points,1);
  const stats=await getQuestionStats(f.env);
  assert.deepEqual(stats.stats,[{questionId:q.id,participants:1,averageScore:11}]);
});
test("HTTP scoring uses the session owner, validates answers, rejects cross-origin and forged points",async t=>{
  const f=fixture(t),origin="https://writing.example";
  const cookie=(await createSession(new Request(origin),f.env,"alice")).split(";")[0];
  const request=(data:unknown,requestOrigin=origin,auth=cookie)=>new Request(origin+"/api/sentence-practice/complete",{method:"POST",headers:{Cookie:auth,Origin:requestOrigin,"Content-Type":"application/json"},body:JSON.stringify(data)});
  const data={sentenceId:first.id,answers};
  assert.equal((await worker.fetch(request(data,origin,""),f.env)).status,401);
  assert.equal((await worker.fetch(request(data,"https://other.example"),f.env)).status,403);
  assert.equal((await worker.fetch(request({...data,points:1000,userId:"bob"}),f.env)).status,400);
  assert.equal((await worker.fetch(request({...data,answers:["wrong"]}),f.env)).status,200);
  assert.equal((await sentenceProgress(f.env,"alice")).points,0);
  const response=await worker.fetch(request(data),f.env);assert.equal(response.status,200);
  assert.equal(response.headers.get("Cache-Control"),"no-store");
  assert.equal((await response.json()).awarded,true);
  assert.equal((await worker.fetch(request(data),f.env).then(r=>r.json())).awarded,false);
  const guest=await worker.fetch(new Request(origin+"/api/sentence-practice?userId=alice"),f.env).then(r=>r.json());
  assert.deepEqual(guest,{completed:[],points:0,todayPoints:0});
  assert.equal((await sentenceProgress(f.env,"bob")).points,0);
  assert.equal((await worker.fetch(new Request(origin+"/api/sentence-practice",{method:"POST"}),f.env)).status,405);
});
