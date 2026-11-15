import { test } from "node:test";
import assert from "node:assert/strict";
import { attachTargetCoaching, generateTargetCoaching, targetCoachingMessages, type TargetCoachingContext } from "../src/lib/target-coaching";
import { targetCoachingText } from "../src/lib/target-coaching-format";
import type { TargetCoachingContent } from "../src/lib/target-coaching-types";

const essay = "University students can prepare for their future careers in several ways. Students can ask relevant people for advice. With a prepared mind, students can make better use of opportunities.";
const context = (target = 14): TargetCoachingContext => ({ scale: "cet", target, essay, question: { examType: "CET4", task: "writing", directions: "Explain how university students can prepare for future careers." }, assessment: { score: 11, scope: "full", summary: "语言清楚，仍可展开具体方法。", reason: "依据本次作答的整体质量评分。" } });
const content = (target: number): TargetCoachingContent => ({
  summary: target > 11 ? "保留原有清楚表达，围绕较高目标进一步展开具体解释。" : "已有表达高于本次目标，先巩固准确表达并练习迁移，不降低原文质量。",
  priorities: [{ focus: target > 11 ? "增加方法与作用之间的解释" : "巩固清楚的表达", reason: "本篇已经明确提出准备的方法。", action: "选一个方法，再补一句它为何有用的解释。" }],
  preserve: [{ quote: "Students can ask relevant people for advice.", reason: "前文已说明是大学生，后文students指代清楚；relevant people不应任意缩窄为staff。" }],
  rewrites: [{ original: "Students can ask relevant people for advice.", replacement: "Students can seek advice from people with relevant experience.", explanation: "这是更具体的可选表达，原句本身不构成语法错误。", boundary: "只有确实希望强调经验时使用，不把相关人士都改成工作人员。" }],
  chunks: [
    { pattern: "seek advice from", meaning: "向某人寻求建议", example: "New students can seek advice from older classmates.", whenToUse: "说明可获得帮助的人时。", caution: "要按真实语境选择建议来源。" },
    { pattern: "make good use of", meaning: "充分利用", example: "Students can make good use of the library.", whenToUse: "讨论资源和机会的利用时。", caution: "需要说明具体利用什么，不作空泛口号。" },
  ],
  practice: { instruction: "自拟微练习：用两至三句提出新生学习建议。", prompt: "新生想了解如何利用校园资源，请说明一种获取帮助的方式。", referenceAnswer: "New students can seek advice from older classmates. This can help them make good use of the library.", explanation: "参考答案把建议来源与资源利用联系起来，其他合理表达也可以。" },
});
const env = { DEEPSEEK_API_KEY: "synthetic-test-key", DEEPSEEK_MODEL: "synthetic-model" };
const completion = (value: unknown, finish = "stop") => Response.json({ model: "synthetic-model", choices: [{ finish_reason: finish, message: { content: JSON.stringify(value) } }] });

test("only goal-aware teaching changes while all objective feedback stays intact", async () => {
  const objective = Object.freeze({ holisticScore: 11, scoreReason: "依据真实原文。", scoringEvidence: Object.freeze({ findings: [] }), revisionAssessment: Object.freeze({ status: "checked", holisticScore: 12 }), improvedEssay: "An already verified revision remains exactly unchanged." });
  const sent: TargetCoachingContext[] = [];
  const fetcher: typeof fetch = async (_url, init) => { const body = JSON.parse(String(init?.body)); const data = JSON.parse(body.messages[1].content); sent.push(data); return completion(content(data.target)); };
  const low = await attachTargetCoaching(objective, context(7), env, fetcher);
  const high = await attachTargetCoaching(objective, context(14), env, fetcher);
  const { targetCoaching: lowPlan, ...lowObjective } = low;
  const { targetCoaching: highPlan, ...highObjective } = high;
  assert.deepEqual(lowObjective, objective); assert.deepEqual(highObjective, objective);
  assert.equal(lowPlan.currentScore, 11); assert.equal(highPlan.currentScore, 11);
  assert.equal(lowPlan.target, 7); assert.equal(highPlan.target, 14);
  assert.notDeepEqual(lowPlan, highPlan);
  assert.deepEqual({ ...sent[0], target: 14 }, sent[1]);
});

test("matching cached teaching is reused but changing the goal regenerates teaching alone", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (_url, init) => { calls++; return completion(content(JSON.parse(JSON.parse(String(init?.body)).messages[1].content).target)); };
  const original = { holisticScore: 11, improvedEssay: "An independently checked revision." };
  const first = await attachTargetCoaching(original, context(7), env, fetcher);
  const same = await attachTargetCoaching(first, context(7), env, fetcher);
  assert.equal(calls, 1); assert.deepEqual(same, first);
  const changed = await attachTargetCoaching(first, context(14), env, fetcher);
  assert.equal(calls, 2); assert.equal(changed.targetCoaching.target, 14);
  assert.equal(changed.holisticScore, original.holisticScore); assert.equal(changed.improvedEssay, original.improvedEssay);
});

test("the same goal and score cannot reuse teaching for a different answer or question", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return completion(content(14)); };
  const first = await attachTargetCoaching({ holisticScore: 11, improvedEssay: "Verified revision." }, context(), env, fetcher);
  const changedAnswer = context(); changedAnswer.essay += " A new explanation belongs to this answer.";
  const second = await attachTargetCoaching(first, changedAnswer, env, fetcher);
  assert.equal(calls, 2);
  assert.notEqual(first.targetCoaching.contextFingerprint, second.targetCoaching.contextFingerprint);
  const changedQuestion = { ...changedAnswer, question: { ...changedAnswer.question, directions: "Discuss preparation for postgraduate study instead." } };
  const third = await attachTargetCoaching(second, changedQuestion, env, fetcher);
  assert.equal(calls, 3);
  assert.equal(third.holisticScore, first.holisticScore);
});

test("malformed, truncated and unavailable teaching never replaces or loses an assessment", async () => {
  const objective = { overallBand: 6.5, criteria: { grammar: { score: 7 } }, improvedEssay: "Verified text." };
  for (const fetcher of [async () => completion(content(14), "length"), async () => Response.json({}, { status: 503 }), async () => { throw Error("synthetic network failure"); }, async () => completion({ ...content(14), score: 15 })]) {
    const result = await attachTargetCoaching(objective, context(), env, fetcher as typeof fetch);
    assert.equal(result.targetCoaching.status, "unavailable");
    const { targetCoaching: _teaching, ...retained } = result; assert.deepEqual(retained, objective);
  }
});

test("insufficient remaining time and invalid goals skip teaching without calling a provider", async () => {
  let calls = 0; const fetcher: typeof fetch = async () => { calls++; return completion(content(14)); };
  const timed = await generateTargetCoaching(context(), env, fetcher, Date.now() + 3000);
  const invalid = await generateTargetCoaching(context(99), env, fetcher);
  assert.equal(calls, 0); assert.equal(timed.status, "unavailable"); assert.equal(invalid.status, "unavailable");
});

test("teaching rejects invented quotes and changed data", async () => {
  for (const change of [
    (c: TargetCoachingContent) => { c.preserve[0].quote = "An invented quotation."; },
    (c: TargetCoachingContent) => { c.rewrites[0].replacement = "Students can seek advice from 20 people."; },
  ]) {
    const result = content(14); change(result);
    assert.equal((await generateTargetCoaching(context(), env, async () => completion(result))).status, "unavailable");
  }
});

test("a teacher or worker elsewhere cannot justify narrowing relevant people to staff", async () => {
  const candidate = content(14); candidate.rewrites[0].replacement = "Students can ask staff for advice.";
  const actualContext = context();
  actualContext.essay += " A graduate may explain working life, while a teacher may suggest a project. Workers can also share their experience.";
  const result = await generateTargetCoaching(actualContext, env, async () => completion(candidate));
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.deepEqual(result.content.rewrites, []);
  assert.equal(result.content.chunks.length, 2);
  assert.equal(result.content.preserve[0].quote, candidate.preserve[0].quote);
});

test("contextual language and non-guaranteed practice are explicit and included in exports", async () => {
  const system = targetCoachingMessages(context())[0].content;
  for (const text of ["students", "university students", "relevant people", "staff", "with a prepared mind", "不能把本来好的文章改差", "不是官方硬性规则"]) assert.ok(system.includes(text));
  for (const text of ["replacement只改变表达方式", "不能在replacement中新添例子、原因、结果", "放priorities建议或自拟练习", "pattern每项只给一个明确", "只讲本pattern的局部句法", "whether还有decide whether to", "for后可以有名词短语或动名词"]) assert.ok(system.includes(text));
  const result = await generateTargetCoaching(context(), env, async () => completion(content(14)));
  const exported = targetCoachingText(result);
  for (const text of ["目标提升", "可选表达", "可迁移", "自拟微练习", "参考答案", "seek advice from"]) assert.ok(exported.includes(text));
  assert.equal(targetCoachingText(), "");
});

test("real-response attainment claims are neutralised without losing useful teaching or objective fields", async () => {
  const unsafe = content(14);
  unsafe.summary = "这篇作文已经达到8分水平，目标8分意味着当前表现已符合要求。";
  unsafe.priorities[0].reason = "使用这些词块保证提分。";
  unsafe.preserve[0].reason = "这句话必定让作文得到高分。";
  unsafe.rewrites[0].explanation = "这样改就能达到8分目标。";
  unsafe.chunks[0].whenToUse = "这个词块保证达到目标。";
  unsafe.practice.explanation = "完成练习一定能够通过。";
  const original = { overallBand: 8, improvedEssay: "An independently verified revision." };
  const result = await attachTargetCoaching(original, { ...context(8), scale: "ielts", assessment: { ...context().assessment, score: 8 } }, env, async () => completion(unsafe));
  assert.equal(result.targetCoaching.status, "ready");
  assert.equal(result.overallBand, 8); assert.equal(result.improvedEssay, original.improvedEssay);
  if (result.targetCoaching.status !== "ready") return;
  assert.ok(result.targetCoaching.content.summary.includes("巩固"));
  assert.ok(result.targetCoaching.content.summary.includes("迁移"));
  assert.equal(result.targetCoaching.content.rewrites.length, 0);
  assert.equal(result.targetCoaching.content.chunks.length, 2);
  assert.ok(result.targetCoaching.content.practice.referenceAnswer.includes("seek advice from"));
  for (const text of ["8分", "保证提分", "必定让作文得到高分", "一定能够通过"]) assert.ok(!JSON.stringify(result.targetCoaching.content).includes(text));
});

test("optional rewrites preserve modal force and negation, including contractions", async () => {
  const original = "A graduate may offer a view of working life. Being prepared can help students. Students should not follow every suggestion. They never choose a course at random. They need to compare options. They can't predict every difficulty. Not all students can attend.";
  const cases = [
    ["A graduate may offer a view of working life.", "A graduate can offer insights into working life.", false],
    ["Being prepared can help students.", "Being prepared helps students.", false],
    ["Students should not follow every suggestion.", "Students should follow every suggestion.", false],
    ["They never choose a course at random.", "They choose a course at random.", false],
    ["They need to compare options.", "They compare options.", false],
    ["They can't predict every difficulty.", "They can predict every difficulty.", false],
    ["They can't predict every difficulty.", "They cannot foresee every difficulty.", true],
    ["Not all students can attend.", "All students cannot attend.", false],
    ["A graduate may offer a view of working life.", "A graduate may offer insights into working life.", true],
  ] as const;
  for (const [from, to, kept] of cases) {
    const candidate = content(14); candidate.preserve[0].quote = "Being prepared can help students.";
    candidate.rewrites = [{ ...candidate.rewrites[0], original: from, replacement: to }];
    const result = await generateTargetCoaching({ ...context(), essay: original }, env, async () => completion(candidate));
    assert.equal(result.status, "ready");
    if (result.status === "ready") assert.equal(result.content.rewrites.length, kept ? 1 : 0, `${from} -> ${to}`);
  }
});

test("score promises in self-made examples and answers make teaching unavailable without fabricated replacements", async () => {
  const original = { holisticScore: 11, improvedEssay: "An already verified revision.", scoringEvidence: { findings: [] } };
  for (const change of [
    (c: TargetCoachingContent) => { c.chunks[0].pattern = "This answer already achieves band 8."; },
    (c: TargetCoachingContent) => { c.chunks[0].example = "This answer already achieves band 8."; },
    (c: TargetCoachingContent) => { c.practice.prompt = "请写一篇一定能够通过考试的答案。"; },
    (c: TargetCoachingContent) => { c.practice.referenceAnswer = "This answer already achieves band 8."; },
  ]) {
    const candidate = content(14); change(candidate);
    const result = await attachTargetCoaching(original, context(), env, async () => completion(candidate));
    assert.equal(result.targetCoaching.status, "unavailable");
    const { targetCoaching: _teaching, ...retained } = result; assert.deepEqual(retained, original);
  }
});

test("unsafe old cached examples regenerate teaching without throwing away the score", async () => {
  const first = await attachTargetCoaching({ holisticScore: 11, improvedEssay: "Verified revision." }, context(), env, async () => completion(content(14)));
  assert.equal(first.targetCoaching.status, "ready");
  if (first.targetCoaching.status !== "ready") return;
  first.targetCoaching.content.practice.referenceAnswer = "This answer already achieves band 8.";
  let calls = 0;
  const refreshed = await attachTargetCoaching(first, context(), env, async () => { calls++; return completion(content(14)); });
  assert.equal(calls, 1); assert.equal(refreshed.targetCoaching.status, "ready");
  assert.equal(refreshed.holisticScore, 11); assert.equal(refreshed.improvedEssay, "Verified revision.");
});
