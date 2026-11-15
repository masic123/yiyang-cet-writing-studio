import assert from "node:assert/strict";
import { test } from "node:test";
import { sqliteDatabase } from "../server/database";
import { answerCatalog, applyScoringAudit, bindAuditEvidence, requirementCatalog, scoringAuditMessages, scoringFingerprint, SCORING_VERSION } from "../src/lib/scoring-audit";
import { assessEssay, assessEssayForOwner, normalizeFeedback, rubric, assessmentMessages } from "../src/lib/reviewer";
import { assessedWordCount, wordCount, type EssayInput, type Feedback, type Question } from "../src/lib/types";
import { attachTargetCoaching } from "../src/lib/target-coaching";

test("given opening sentences are protected and explicit excluded words are counted correctly", () => {
  const given = "With the trend of Urbanization, it is vitally important for city residents to develop a stronger love for Nature.";
  const question = { ...q, stem: 'Write an essay that begins with the sentence "' + given + '" in at least 40 words, not including the sentence given.' };
  const answer = given + " " + essay;
  assert.equal(assessedWordCount(answer, question), wordCount(essay));
  const i = { ...input(), essay: answer };
  const c = { ...candidate(), improvedEssay: answer, corrections: [] };
  const a = { ...assessment(answer), strengths: [], taskChecks: [{ requirement: "not including the sentence given", status: "met", evidence: [essay], explanation: "题目要求有明确对应证据。" }], findings: [{ kind: "grammar", severity: "minor", original: given, replacement: given.replace("Urbanization", "urbanization"), requirement: "", reason: "将普通名词改为小写，这是未经核实的大小写指责。" }] };
  assert.throws(() => applyScoringAudit({ original: a, revision: a, correctionDecisions: [] }, i, question, c), /指定首句/);
});

const q: Question = { id: 1, name: "合成测试", examType: "CET4", task: "writing", session: "", set: 1, category: "建议", topic: "研究项目", stem: "Discuss the necessity and practicality of a research project in 40 to 180 words.", sourceText: "", wordLimit: { min: 40, max: 180 }, timeLimit: 30, sourceType: "custom", sourceUrl: "", images: [], needsVisual: false, transcriptionStatus: "verified" };
const essay = "Research helps students apply what they learn. A small survey can teach them to compare sources and judge evidence. Teachers can guide beginners and limit the project to two weeks. These abilities benefit their future study and career. This makes the requirement both useful and practical.";
const input = (targetScore = 11): EssayInput => ({ questionId: 1, essay, title: "合成一致性测试", targetScore });
const optional = { original: "These abilities benefit their future study and career.", replacement: "These abilities will benefit their future study and career.", kind: "clarity" as const, reason: "可选优化：原句表达一般作用时正确，不必加will。" };
function candidate(): Feedback {
  return normalizeFeedback({ summary: "这是用于检验复核逻辑的合成报告，不能代表真实阅卷结果。", holisticScore: 11, scoreReason: "未经复核的候选分数不能成为最终评分依据。", diagnostics: [{ area: "任务完成", status: "developing", evidence: essay, advice: "检查要点。" }], strengths: [], priorities: [], methodChecks: [], paragraphs: [], corrections: [optional], alignment: [], improvedEssay: essay.replace(optional.original, optional.replacement), advancedSuggestions: [], exercises: [] }, input(), q);
}
function assessment(text = essay, score = 14) {
  return { holisticScore: score, taskRelevance: { status: "relevant" as "relevant" | "partial" | "off_topic", reason: "围绕研究项目的必要性和可行性完成交流任务。" }, summary: "作答完成题目要点，表达清楚连贯，未核实到必须修改的语言问题。", scoreReason: "必要性和可行性均有具体说明，语言准确自然，符合13-15档的整体描述。", strengths: [{ quote: text.slice(0, text.indexOf(".") + 1), explanation: "用明确的作用解释研究项目的必要性。" }], taskChecks: [{ requirement: "necessity and practicality", status: "met", evidence: ["A small survey can teach them to compare sources and judge evidence.", "Teachers can guide beginners and limit the project to two weeks."], explanation: "必要性与实际实施方式都有明确说明。" }], findings: [] as Array<{ kind: string; severity: string; original: string; replacement: string; requirement: string; reason: string }> };
}
function audit(score = 14) {
  return { original: assessment(essay, score), revision: assessment(candidate().improvedEssay, score), correctionDecisions: [{ index: 0, classification: "optional", reason: "一般现在时表达普遍作用，增加will只改变时间侧重点，不是纠错。" }] };
}
function checkedClaims(init?: RequestInit, invalidId?: string) {
  const payload = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
  if (!Array.isArray(payload.claims)) return undefined;
  return completion({ decisions: payload.claims.map((c: { id: string }) => ({ id: c.id, verdict: c.id === invalidId ? "invalid" : "valid", reason: c.id === invalidId ? "一般现在时可以表达普遍作用，will不是必需。" : "合成测试中的已知任务与证据一致。" })) });
}
const completion = (raw: unknown) => Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(raw) } }] });

test("answer IDs bind to the correct side and cannot fabricate a quotation", () => {
  const raw = audit() as any;
  raw.original.strengths = [{ quoteId: "a0", explanation: "开篇具体解释研究的学习作用。" }];
  raw.original.taskChecks[0].evidenceIds = ["a1", "a2"];
  const bound = bindAuditEvidence(raw, input(), q, candidate()) as any;
  assert.equal(bound.original.strengths[0].quote, answerCatalog(essay, "A")[0].quote);
  assert.deepEqual(bound.original.taskChecks[0].evidence, assessment().taskChecks[0].evidence);
  assert.equal(applyScoringAudit(raw, input(), q, candidate()).holisticScore, 14);
  raw.original.strengths[0].quoteId = "b0";
  assert.throws(() => applyScoringAudit(raw, input(), q, candidate()), /对应答卷目录/);
});

test("a completely off-topic classification cannot coexist with a basically on-topic score", () => {
  const raw = audit(8);
  raw.original.taskRelevance = { status: "off_topic", reason: "实际回答另一个主题，没有回应本题核心交流任务。" };
  assert.throws(() => applyScoringAudit(raw, input(), q, candidate()), /整篇完全跑题/);
  const question = { ...q, stem: q.stem + " The statement given below is for your reference. An optional viewpoint." };
  assert.ok(!requirementCatalog(input(), question).some(r => r.quote.includes("optional viewpoint")));
});

test("a copied-opening grammar error can also support its task check without duplicate accusations", () => {
  const raw = audit();
  raw.original.taskChecks[0].status = "partial";
  raw.original.findings = [{ kind: "grammar", severity: "minor", original: optional.original, replacement: optional.replacement, requirement: "necessity and practicality", reason: "合成证据：同一条已核实问题对应任务要点，无须重复指责。" }];
  assert.doesNotThrow(() => applyScoringAudit(raw, input(), q, candidate()));
});

test("a miscopied prescribed opening cannot be excused as verbatim source text", () => {
  const given = "Research helps students apply what they learn.";
  const changed = given.replace("helps", "help");
  const question = { ...q, stem: 'Write an essay that begins with the sentence "' + given + '". Discuss the necessity and practicality of a research project in 40 to 180 words.' };
  const i = { ...input(), essay: essay.replace(given, changed) };
  const c = { ...candidate(), improvedEssay: essay, corrections: [] };
  const a = { ...assessment(i.essay), taskChecks: [{ requirement: "necessity and practicality", status: "met", evidence: [i.essay], explanation: "正文内容有对应证据。" }] };
  assert.throws(() => applyScoringAudit({ original: a, revision: assessment(), correctionDecisions: [] }, i, question, c), /首句未准确照抄/);
  a.findings = [{ kind: "grammar", severity: "minor", original: changed, replacement: given, requirement: "", reason: "单数主语Research的谓语应为helps；题面给的是helps，考生抄成help，不属于题面原有的错误。" }];
  assert.doesNotThrow(() => applyScoringAudit({ original: a, revision: assessment(), correctionDecisions: [] }, i, question, c));
});

test("length repair actually replaces an incomplete candidate and refuses repeated failures", async () => {
  let calls = 0;
  const f = await assessEssay(input(), q, { DEEPSEEK_API_KEY: "synthetic-test" }, undefined, async (_url, init) => {
    const checked = checkedClaims(init); if (checked) return checked;
    calls++;
    return completion(calls === 1 ? { ...candidate(), improvedEssay: "This is a very short answer about research." } : calls === 2 ? { improvedEssay: candidate().improvedEssay } : audit());
  });
  assert.equal(calls, 3);
  assert.ok(assessedWordCount(f.improvedEssay, q) >= q.wordLimit!.min);
  calls = 0;
  await assert.rejects(assessEssay(input(), q, { DEEPSEEK_API_KEY: "synthetic-test" }, undefined, async () => {
    calls++;
    return completion(calls === 1 ? { ...candidate(), improvedEssay: "This is a very short answer about research." } : { improvedEssay: "This answer about research is still too short." });
  }), /仍不符合题面词数/);
  assert.equal(calls, 4);
});

test("a focused claim check rejects a false accusation before a score can be returned", async () => {
  const falseAudit = audit();
  falseAudit.original.findings = [{ kind: "grammar", severity: "minor", original: optional.original, replacement: optional.replacement, requirement: "", reason: "一般作用必须使用将来时will，这是故意设置的错误指责。" }];
  const clean = audit();
  let calls = 0;
  const result = await assessEssay(input(), q, { DEEPSEEK_API_KEY: "synthetic-test" }, undefined, async (_url, init) => {
    calls++;
    const checked = checkedClaims(init, "original:0");
    if (checked) return checked;
    return completion(calls === 1 ? candidate() : calls === 2 ? falseAudit : clean);
  });
  assert.equal(calls, 5);
  assert.deepEqual(result.corrections, []);
  assert.ok(!result.scoreReason.includes("必须使用将来时"));
});

test("claim verification distinguishes optional edits from supported task and relevance judgments", async () => {
  let seen = false;
  const result = await assessEssay(input(), q, { DEEPSEEK_API_KEY: "synthetic-test" }, undefined, async (_url, init) => {
    const payload = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    if (payload.claims) {
      seen = true;
      assert.ok(payload.claims.some((c: any) => c.claimType === "taskCheck" && c.taskCheck.status === "met"));
      assert.ok(payload.claims.some((c: any) => c.claimType === "taskRelevance" && c.taskRelevance.status === "relevant"));
      for (const c of payload.claims) assert.deepEqual(c.allowedVerdicts, ["valid", "invalid"]);
      return completion({ decisions: payload.claims.map((c: any) => ({ id: c.id, verdict: "valid", reason: "答卷证据支持这个完成状态，符合要求不等于可选润色。" })) });
    }
    return completion(payload.answerA ? audit() : candidate());
  });
  assert.ok(seen);
  assert.equal(result.holisticScore, 14);
});

test("an optional verdict for task status is rejected rather than silently accepted", async () => {
  let checks = 0;
  await assert.rejects(assessEssay(input(), q, { DEEPSEEK_API_KEY: "synthetic-test" }, undefined, async (_url, init) => {
    const payload = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    if (payload.claims) {
      checks++;
      return completion({ decisions: payload.claims.map((c: any) => ({ id: c.id, verdict: "optional", reason: "状态成立，但这份故意构造的响应错误地用了可选标签。" })) });
    }
    return completion(payload.answerA ? audit() : candidate());
  }), /错误核验未完成/);
  assert.equal(checks, 3);
});

test("blind audit and generation omit target, prior grades, titles and fixed example scores", () => {
  assert.deepEqual(assessmentMessages(input(2), q), assessmentMessages(input(15), q));
  const a = scoringAuditMessages(input(2), q, candidate(), rubric);
  const b = scoringAuditMessages(input(15), q, { ...candidate(), holisticScore: 4, summary: "旧报告锚定4分", scoreReason: "之前给4分" }, rubric);
  assert.deepEqual(a, b);
  const payload = JSON.parse(a[1].content);
  assert.ok(!("targetScore" in payload));
  assert.ok(!("holisticScore" in payload));
  assert.ok(!a[1].content.includes("之前给4分"));
});

test("optional edits leave corrections and cannot support a low score", () => {
  const f = applyScoringAudit(audit(), input(), q, candidate());
  assert.deepEqual(f.corrections, []);
  assert.deepEqual(f.priorities, []);
  assert.equal(f.advancedSuggestions!.length, 1);
  assert.match(f.advancedSuggestions![0].explanation, /不计为错误/);
  assert.equal(f.revisionAssessment!.holisticScore, 14);
  assert.equal(f.revisionAssessment!.status, "checked");
  assert.throws(() => applyScoringAudit(audit(11), input(), q, candidate()), /没有可核实的实质问题/);
});

test("audit rejects fabricated evidence and publishes only verified problems in grading prose", () => {
  const requirement = audit(); requirement.original.taskChecks[0].requirement = "Use three complex sentences";
  assert.throws(() => applyScoringAudit(requirement, input(), q, candidate()), /题面引文无法定位/);
  const fabricated = audit(); fabricated.original.strengths[0].quote = "Words the student never wrote.";
  assert.throws(() => applyScoringAudit(fabricated, input(), q, candidate()), /优点引用无法定位/);
  const contradiction = audit(); contradiction.original.scoreReason = "整体文字通顺，但仍有少量语言错误，应按真实语言错误定档。";
  assert.doesNotMatch(applyScoringAudit(contradiction, input(), q, candidate()).scoreReason, /仍有少量语言错误/);
  const hidden = audit(); hidden.original.summary = "虽有少量冠词小瑕疵，但完成所有要求。";
  assert.doesNotMatch(applyScoringAudit(hidden, input(), q, candidate()).summary, /冠词小瑕疵/);
  const length = audit(); length.original.findings = [{ kind: "length", severity: "minor", original: "", replacement: "", requirement: "40 to 180 words", reason: "词数刚刚超过下限，需要更多字数。" }];
  assert.throws(() => applyScoringAudit(length, input(), q, candidate()), /词数范围内/);
  const optionalFinding = audit(); optionalFinding.original.findings = [{ kind: "clarity", severity: "minor", original: optional.original, replacement: optional.replacement, requirement: "", reason: "原句正确，这是可选优化。" }];
  assert.throws(() => applyScoringAudit(optionalFinding, input(), q, candidate()), /可选润色/);
});

test("word-count and translation-coverage omissions cannot pass a clean audit", () => {
  assert.throws(() => applyScoringAudit(audit(), input(), { ...q, wordLimit: { min: 100, max: 180 } }, candidate()), /没有词数问题记录/);
  const tq: Question = { ...q, task: "translation", stem: "Translate.", sourceText: "研究帮助学生应用知识。教师可以指导初学者。", wordLimit: null };
  const raw = audit() as any;
  raw.original.taskChecks = [{ requirementId: "r0", status: "met", evidence: ["Research helps students apply what they learn."], explanation: "原文信息有对应表达。" }];
  raw.revision.taskChecks = structuredClone(raw.original.taskChecks);
  assert.throws(() => applyScoringAudit(raw, input(), tq, candidate()), /翻译对照遗漏了原文要点/);
  raw.original.taskChecks.push({ requirementId: "r1", status: "missing", evidence: [], explanation: "该信息未译出，需要给出依据。" });
  assert.throws(() => applyScoringAudit(raw, input(), tq, candidate()), /翻译对照遗漏了原文要点/);
});

test("an unchanged revision uses the exact same audited assessment", () => {
  const c = { ...candidate(), improvedEssay: essay, corrections: [] };
  const raw = { original: assessment(essay, 14), revision: assessment(essay, 13), correctionDecisions: [] };
  const result = applyScoringAudit(raw, input(), q, c);
  assert.equal(result.holisticScore, result.revisionAssessment!.holisticScore);
});

test("a major omission and a high-band completeness claim cannot coexist", () => {
  const raw = audit();
  raw.original.taskChecks[0].status = "missing";
  raw.original.findings = [{ kind: "task", severity: "major", original: "", replacement: "Explain why this is practical.", requirement: "necessity and practicality", reason: "任务中的实际可行性要求完全没有完成，属于实质内容缺失。" }];
  assert.throws(() => applyScoringAudit(raw, input(), q, candidate()), /仍按准确完整的高档/);
});

test("revision can retain the same score and can be worse when it introduces a verified error", () => {
  const same = applyScoringAudit(audit(), input(), q, candidate());
  assert.equal(same.holisticScore, same.revisionAssessment!.holisticScore);
  const c = candidate(); c.improvedEssay = c.improvedEssay.replace("Research helps", "Research help");
  const raw = audit(); raw.revision = assessment(c.improvedEssay, 12);
  raw.revision.findings = [{ kind: "grammar", severity: "minor", original: "Research help students apply what they learn.", replacement: "Research helps students apply what they learn.", requirement: "", reason: "单数主语Research的谓语应使用helps，与主语保持一致。" }];
  const checked = applyScoringAudit(raw, input(), q, c);
  assert.equal(checked.revisionAssessment!.status, "needs_work");
  assert.equal(checked.revisionAssessment!.holisticScore, 12);
  assert.match(checked.summary, /仍需解决/);
});

test("server-owned requirement IDs and translation alignments use verified evidence", () => {
  const source = "研究帮助学生应用知识。教师可以指导初学者。";
  const tq: Question = { ...q, task: "translation", stem: "Translate the Chinese passage into English.", sourceText: source, wordLimit: null };
  const c = { ...candidate(), alignment: [{ source: "研究帮助学生应用知识。", student: "Research helps students apply what they learn.", status: "mistranslated" as const, explanation: "不该延续的候选错误指责", suggestion: "错误的候选修改" }] };
  const raw = audit() as any;
  raw.original.taskChecks = [{ requirementId: "r0", status: "met", evidence: ["Research helps students apply what they learn."], explanation: "准确传达研究对知识应用的作用。" }, { requirementId: "r1", status: "met", evidence: ["Teachers can guide beginners and limit the project to two weeks."], explanation: "教师指导的信息清楚。" }];
  raw.revision.taskChecks = structuredClone(raw.original.taskChecks);
  const result = applyScoringAudit(raw, input(), tq, c);
  assert.equal(result.alignment[0].source, "研究帮助学生应用知识。");
  assert.equal(result.alignment[0].status, "accurate");
  assert.ok(!JSON.stringify(result.alignment).includes("候选错误指责"));
  raw.original.taskChecks[0].requirementId = "r99";
  assert.throws(() => applyScoringAudit(raw, input(), tq, c), /引用编号不在目录/);
});

test("fingerprint ignores targets and titles but changes with answer, model, source or exam level", async () => {
  const first = await scoringFingerprint(input(), q, "test-model");
  assert.equal(first, await scoringFingerprint({ ...input(15), title: "另一个标题" }, q, "test-model"));
  for (const [i, question, model] of [[{ ...input(), essay: essay + " New content." }, q, "test-model"], [input(), { ...q, examType: "CET6" }, "test-model"], [input(), q, "different-model"]] as const) {
    assert.notEqual(first, await scoringFingerprint(i, question, model));
  }
});

test("provider uses a separate blind audit and never falls back to an inconsistent initial grade", async () => {
  const requests: { messages: { role: string; content: string }[]; temperature: number }[] = [];
  const feedback = await assessEssay(input(), q, { DEEPSEEK_API_KEY: "synthetic-test" }, undefined, async (_url, init) => {
    requests.push(JSON.parse(String(init!.body)));
    return checkedClaims(init) || completion(requests.length === 1 ? candidate() : audit());
  });
  assert.equal(requests.length, 3);
  assert.ok(requests.every(r => r.temperature === 0));
  assert.equal(feedback.holisticScore, 14);
  assert.equal(feedback.assessmentVersion, SCORING_VERSION);
  assert.ok(feedback.assessmentFingerprint);
  let calls = 0;
  await assert.rejects(assessEssay(input(), q, { DEEPSEEK_API_KEY: "synthetic-test" }, undefined, async (_url, init) => checkedClaims(init) || completion(++calls === 1 ? candidate() : audit(11))), /未经核实的分数/);
  assert.equal(calls, 4);
});

test("saved assessments are reused only for the current owner, model, version and exact task-answer fingerprint", async () => {
  const { sql, db } = sqliteDatabase(":memory:");
  try {
    const f = { ...applyScoringAudit(audit(), input(), q, candidate()), assessmentVersion: SCORING_VERSION, assessmentFingerprint: await scoringFingerprint(input(), q, "test-model") };
    sql.prepare("INSERT INTO users VALUES('owner','owner@example.test','owner','!synthetic','2026-10-29'),('other','other@example.test','other','!synthetic','2026-10-29')").run();
    sql.prepare("INSERT INTO reviews(id,user_id,input,question,status,feedback,model,refs,request_key,created_at) VALUES('review','owner',?,?,'completed',?,'test-model','[]','request','2026-10-29')").run(JSON.stringify(input()), JSON.stringify(q), JSON.stringify(f));
    let calls = 0, teachingCalls = 0;
    const requestFetch: typeof fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      const payload = JSON.parse(request.messages[1].content);
      if (payload.scale === "cet" && "target" in payload && "assessment" in payload) {
        teachingCalls++;
        return Response.json({}, { status: 503 }); // optional guidance must not invalidate cached scores
      }
      return checkedClaims(init) || completion(++calls % 2 ? candidate() : audit());
    };
    const env = { DB: db, DEEPSEEK_API_KEY: "synthetic-test", DEEPSEEK_MODEL: "test-model" };
    const cached = await assessEssayForOwner(input(15), q, env, "owner", requestFetch);
    assert.equal(calls, 0);
    assert.equal(cached.holisticScore, f.holisticScore);
    assert.equal(teachingCalls, 1);
    assert.equal(cached.targetCoaching?.target, 15);
    assert.equal(cached.targetCoaching?.status, "unavailable");
    const revisionInput = { ...input(15), essay: f.improvedEssay };
    f.revisionAssessment!.assessmentFingerprint = await scoringFingerprint(revisionInput, q, "test-model");
    sql.prepare("UPDATE reviews SET feedback=? WHERE id='review'").run(JSON.stringify(f));
    const checkedRevision = await assessEssayForOwner(revisionInput, q, env, "owner", requestFetch);
    assert.equal(calls, 0);
    assert.equal(checkedRevision.holisticScore, f.revisionAssessment!.holisticScore);
    assert.deepEqual(checkedRevision.corrections, []);
    assert.deepEqual(checkedRevision.scoringEvidence, f.revisionAssessment!.scoringEvidence);
    await assessEssayForOwner(input(), q, env, "other", requestFetch);
    assert.equal(calls, 2);
    sql.prepare("UPDATE reviews SET feedback=json_set(feedback,'$.assessmentVersion','obsolete')").run();
    await assessEssayForOwner(input(), q, env, "owner", requestFetch);
    assert.equal(calls, 4);
    assert.equal(teachingCalls, 4);
  } finally { sql.close(); }
});

test("equal original and revision scores do not reuse guidance quoted from the previous answer", async () => {
  const { sql, db } = sqliteDatabase(":memory:");
  try {
    const env = { DB: db, DEEPSEEK_API_KEY: "synthetic-test", DEEPSEEK_MODEL: "test-model" };
    const objective = { ...applyScoringAudit(audit(), input(), q, candidate()), assessmentVersion: SCORING_VERSION, assessmentFingerprint: await scoringFingerprint(input(), q, "test-model") };
    const context = { scale: "cet" as const, target: 15, essay, question: { examType: q.examType, task: q.task, directions: q.stem, sourceText: q.sourceText, wordLimit: q.wordLimit }, assessment: { score: objective.holisticScore, scope: objective.assessmentScope, summary: objective.summary, reason: objective.scoreReason, priorities: objective.priorities, corrections: objective.corrections } };
    let teachingCalls = 0;
    const teachingOnly: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)), payload = JSON.parse(body.messages[1].content);
      assert.equal(payload.scale, "cet", "cached revision must not be graded again");
      assert.equal(payload.target, 15); assert.equal(payload.assessment.score, objective.holisticScore);
      teachingCalls++;
      const quote = payload.essay.includes(optional.original) ? optional.original : optional.replacement;
      return completion({ summary: "根据当前答卷安排表达迁移练习，不改变已核验分数。", priorities: [{ focus: "保留原意", reason: "本篇表达已经清楚。", action: "用一个新场景练习同一表达。" }], preserve: [{ quote, reason: "这句是当前答卷中的真实表达。" }], rewrites: [], chunks: [
        { pattern: "benefit their future study", meaning: "有利于今后的学习", example: "These skills benefit their future study.", whenToUse: "讨论技能作用时。", caution: "不需要机械加will。" },
        { pattern: "compare sources", meaning: "比较资料来源", example: "Students can compare sources before writing.", whenToUse: "讨论研究方法时。", caution: "需有具体资料语境。" },
      ], practice: { instruction: "自拟练习。", prompt: "用两句解释研究技能的作用。", referenceAnswer: "Students can compare sources. These skills benefit their future study.", explanation: "表达与作用之间的联系。" } });
    };
    const saved = await attachTargetCoaching(objective, context, env, teachingOnly);
    assert.equal(saved.targetCoaching.status, "ready");
    const revisionInput = { ...input(15), essay: objective.improvedEssay };
    saved.revisionAssessment!.assessmentFingerprint = await scoringFingerprint(revisionInput, q, "test-model");
    assert.equal(saved.holisticScore, saved.revisionAssessment!.holisticScore);
    assert.ok(!revisionInput.essay.includes(optional.original));
    sql.prepare("INSERT INTO users VALUES('owner','owner@example.test','owner','!synthetic','2026-10-29')").run();
    sql.prepare("INSERT INTO reviews(id,user_id,input,question,status,feedback,model,refs,request_key,created_at) VALUES('original','owner',?,?,'completed',?,'test-model','[]','synthetic-original','2026-10-29')").run(JSON.stringify(input(15)), JSON.stringify(q), JSON.stringify(saved));
    teachingCalls = 0;
    const result = await assessEssayForOwner(revisionInput, q, env, "owner", teachingOnly);
    assert.equal(teachingCalls, 1); assert.equal(result.holisticScore, objective.revisionAssessment!.holisticScore);
    assert.equal(result.targetCoaching?.status, "ready");
    assert.notEqual(result.targetCoaching?.contextFingerprint, saved.targetCoaching.contextFingerprint);
    if (result.targetCoaching?.status === "ready") assert.ok(result.targetCoaching.content.preserve.every(p => revisionInput.essay.includes(p.quote)));
  } finally { sql.close(); }
});
