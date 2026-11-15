import { test } from "node:test";
import assert from "node:assert/strict";
import { applyScoringAudit, requirementCatalog } from "../src/lib/scoring-audit";
import { assessEssay, normalizeFeedback } from "../src/lib/reviewer";
import type { EssayInput, Question } from "../src/lib/types";
import { sqliteDatabase } from "../server/database";
import { digest } from "../worker/auth";
import worker from "../worker/index";
const question: Question = {id:1,name:"漏译回归测试",examType:"CET4",task:"translation",session:"",set:1,category:"翻译",topic:"",stem:"Translate the following passage into English.",sourceText:"中国尊重教师。教师节是九月十日。学生向老师表达谢意。",wordLimit:null,timeLimit:30,sourceType:"custom",sourceUrl:"",images:[],needsVisual:false,transcriptionStatus:"verified"};
const input: EssayInput={questionId:null,customQuestion:{stem:question.stem,sourceText:question.sourceText,task:"translation",examType:"CET4",needsVisual:false},essay:"China respects teachers.",targetScore:11,title:"Partial translation"};
const revised="China respects teachers. Teachers' Day is on September 10. Students express gratitude to their teachers.";
function candidate(){return normalizeFeedback({summary:"用于验证翻译遗漏可以正常评分的合成报告。",holisticScore:5,scoreReason:"只译出了第一句，缺失日期和表达谢意的内容。",diagnostics:[{area:"原文信息",status:"priority",evidence:"缺少日期和谢意的信息。",advice:"对照中文补全后两句。"}],strengths:[],priorities:[],methodChecks:[],paragraphs:[],corrections:[],alignment:requirementCatalog(input,question).map((r,i)=>({source:r.quote,student:i?"":input.essay,status:i?"missing":"accurate",explanation:i?"本句信息在已提交英文中没有译出。":"第一句的基本信息准确表达。",suggestion:""})),improvedEssay:revised,advancedSuggestions:[],exercises:[]},input,question);}
function audit(){return {original:{holisticScore:5,strengths:[],taskChecks:[{requirementId:"r0",status:"met",evidenceIds:["a0"],explanation:"准确传达了尊重教师的基本意思。"},{requirementId:"r1",status:"missing",evidenceIds:[""],explanation:"原作答没有译出教师节的日期。"},{requirementId:"r2",status:"missing",evidence:[""],explanation:"原作答没有译出学生表达谢意的信息。"}],findings:[] as any[]},revision:{holisticScore:14,strengths:[],taskChecks:[0,1,2].map(i=>({requirementId:"r"+i,status:"met",evidenceIds:["b"+i],explanation:"修改稿包含本句的全部主要信息。"})),findings:[]},correctionDecisions:[]};}
test("omitted source sentences are a scored content deficiency, not missing model evidence",()=>{
 const result=applyScoringAudit(audit(),input,question,candidate());
 assert.equal(result.holisticScore,5);assert.equal(result.alignment.filter(a=>a.status==="missing").length,2);
 assert.equal(result.alignment[1].student,"");assert.match(result.scoreReason,/教师节是九月十日/);assert.ok(result.priorities.some(p=>p.title.includes("漏译")));
 assert.equal(result.revisionAssessment?.status,"checked");assert.equal(result.revisionAssessment?.holisticScore,14);
 assert.ok(result.alignment[1].suggestion.includes("September 10"));
 const bad=audit();bad.original.taskChecks[0].evidenceIds=["a999"];
 assert.throws(()=>applyScoringAudit(bad,input,question,candidate()),/对应答卷目录/);
});
test("a missing English phrase does not require an invented original or replacement",()=>{
 const raw=audit();raw.original.findings.push({kind:"accuracy",severity:"major",originalId:"",replacement:"",requirementId:"r1",reason:"缺少教师节日期这一中文原文中的主要信息。"});
 const result=applyScoringAudit(raw,input,question,candidate());assert.equal(result.holisticScore,5);assert.equal(result.corrections.length,0);
});
test("the complete review pipeline scores a short partial translation and verifies missing checks",async()=>{
 let claims=0;
 const result=await assessEssay(input,question,{DEEPSEEK_API_KEY:"synthetic-only"},undefined,async(_url,init)=>{
  const body=JSON.parse(String(init?.body));const data=JSON.parse(body.messages[1].content);
  let output;
  if(data.claims){claims++;output={decisions:data.claims.map((c:{id:string})=>({id:c.id,verdict:"valid",reason:"逐项核对合成答卷，缺少的两句确实没有译出。"}))};}
  else output=data.answerA?audit():candidate();
  return Response.json({choices:[{finish_reason:"stop",message:{content:JSON.stringify(output)}}]});
 });
 assert.equal(result.holisticScore,5);assert.ok(claims>0);assert.equal(result.alignment[2].status,"missing");
});

test("a malformed translation revision preserves independently verified omissions in the original",async()=>{
 let claims=0;
 const result=await assessEssay(input,question,{DEEPSEEK_API_KEY:"synthetic-only"},undefined,async(_url,init)=>{
  const data=JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
  let output;
  if(data.claims){
   claims++;
   assert.ok(data.claims.every((c:{side:string})=>c.side==="original"));
   output={decisions:data.claims.map((c:{id:string})=>({id:c.id,verdict:"valid",reason:"已核对合成译文，日期和谢意确实没有译出。"}))};
  }else if(data.answerA){const raw:any=audit();raw.revision.taskChecks[0].evidenceIds=["b999"];output=raw;}
  else output=candidate();
  return Response.json({choices:[{finish_reason:"stop",message:{content:JSON.stringify(output)}}]});
 });
 assert.ok(claims>0);assert.equal(result.holisticScore,5);
 assert.equal(result.alignment[2].status,"missing");assert.equal(result.improvedEssay,"");
 assert.equal(result.revisionAssessment?.status,"unverified");assert.equal(result.revisionAssessment?.assessmentFingerprint,undefined);
});
test("translation submission accepts fewer than thirty words while writing keeps its existing guard",async t=>{
 const {sql,db}=sqliteDatabase(":memory:");t.after(()=>sql.close());
 const token="d".repeat(64);sql.prepare("INSERT INTO users(id,name,email,password,created_at) VALUES('a','A','a@example.test','!test','now')").run();sql.prepare("INSERT INTO sessions VALUES(?,?,?)").run(await digest(token),"a",Date.now()+86400_000);
 const submit=(value:EssayInput)=>worker.fetch(new Request("https://writing.example/api/reviews",{method:"POST",headers:{Origin:"https://writing.example",Cookie:"cet_session="+token,"Content-Type":"application/json"},body:JSON.stringify({input:value,requestKey:crypto.randomUUID()})}),{DB:db,ASSETS:{fetch:async()=>new Response("asset")}});
 const accepted=await submit(input);assert.equal(accepted.status,503);assert.equal((await accepted.json()).code,"NOT_CONFIGURED");
 assert.equal((await submit({...input,essay:""})).status,400);
 assert.equal((await submit({...input,customQuestion:{...input.customQuestion!,task:"writing",sourceText:""}})).status,400);
});
