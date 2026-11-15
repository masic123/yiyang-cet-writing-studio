import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import worker from "../worker/index";
import { sqliteDatabase } from "../server/database";
import initialSchema from "../worker/schema";
import { questions } from "../src/lib/content";
import { extractNotebookMistakes } from "../src/lib/notebook";
import { normalizeFeedback } from "../src/lib/reviewer";
import { generateNotebookPractice, checkNotebookPractice } from "../src/lib/notebook-practice";
import { getNotebookData, updateNotebookItem, syncNotebook, archiveReviewMistakes, expireNotebookJobs } from "../worker/notebook";
import { beginReview, finishReview } from "../worker/repository";
import { teacherHistory } from "../worker/teacher-history";
import type { EssayInput, Feedback, Review } from "../src/lib/types";
import type { NotebookData, NotebookExercise, PracticeContent, PracticeTarget, PracticeFeedback } from "../src/lib/notebook-types";
import type { Env } from "../worker/types";
import AITeacher from "../src/components/ai-teacher";
import { REGISTRATION_NOTICE_VERSION } from "../src/lib/registration-notice";

const question = questions().find((q) => q.task === "writing" && !q.needsVisual)!;
const makeInput = (essay = "The library can helps students. Students could chooses useful books. We pay attentions to their needs."): EssayInput => ({
  questionId: question.id, essay, targetScore: 11, title: "明确标识的合成测试作答",
});
function feedback(input = makeInput()): Feedback {
  return {
    summary: "这是一份明确标识的合成批改，用来验证归档和练习流程。",
    holisticScore: 8, bandRange: "7-9", scoreReason: "这是测试样本的非官方参考评价，不是真实考试记录。", assessmentScope: "full",
    diagnostics: [], strengths: [], priorities: [], methodChecks: [], paragraphs: [], alignment: [],
    corrections: [
      { original: "The library can helps students.", replacement: "The library can help students.", kind: "grammar", reason: "情态动词 can 后应使用动词原形，不能加 -s。" },
      { original: "Students could chooses useful books.", replacement: "Students could choose useful books.", kind: "grammar", reason: "情态动词 could 后误用了第三人称单数形式，应使用动词原形。" },
      { original: "We pay attentions to their needs.", replacement: "We pay attention to their needs.", kind: "vocabulary", reason: "固定搭配 pay attention to 中 attention 不可数，不能加 s。" },
    ].filter((c) => input.essay.includes(c.original)) as Feedback["corrections"],
    improvedEssay: input.essay, advancedSuggestions: [], exercises: [],
  };
}
function environment(path = ":memory:") {
  const { sql, db } = sqliteDatabase(path);
  const env: Env = { DB: db, ASSETS: { fetch: async () => new Response("asset") } };
  const origin = "http://127.0.0.1:3002";
  const request = (path: string, method = "GET", data?: unknown, cookie?: string, from = origin) => worker.fetch(new Request(`${origin}${path}`, {
    method, headers: { Origin: from, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  }), env);
  async function register(email: string) {
    const response = await request("/api/auth", "POST", { action: "register", email, name: "合成测试账号", password: "Synthetic-test-94578", acceptNotice: true, noticeVersion: REGISTRATION_NOTICE_VERSION });
    assert.equal(response.status, 200);
    const { user } = await response.json();
    return { owner: user.id as string, cookie: response.headers.get("set-cookie")!.split(";")[0] };
  }
  function seed(owner: string, input = makeInput(), date = "2026-10-27T10:00:00.000Z", reportFeedback = feedback(input)): Review {
    const id = crypto.randomUUID();
    sql.prepare("INSERT INTO reviews(id,user_id,input,question,status,feedback,model,refs,request_key,created_at) VALUES(?,?,?,?,'completed',?,'synthetic-test','[]',?,?)")
      .run(id, owner, JSON.stringify(input), JSON.stringify(question), JSON.stringify(reportFeedback), crypto.randomUUID(), date);
    return { id, draftId: null, status: "completed", createdAt: date, input, question, feedback: reportFeedback, model: "synthetic-test", error: null, references: [] };
  }
  return { sql, env, request, register, seed };
}
const completion = (content: unknown, finish = "stop") => Response.json({ choices: [{ finish_reason: finish, message: { content: JSON.stringify(content) } }] });
function content(targets: PracticeTarget[]): PracticeContent {
  const expressions = targets.map((t) => t.kind === "grammar" ? "can help students" : "pay attention to");
  return { title: "校园服务改善", instruction: "将下面的中文段落译为英文。", prompt: "图书馆能够帮助学生学习。工作人员应关注学生的需要。", referenceAnswer: "The library can help students learn. Staff should pay attention to their needs.", coverage: targets.map((t, i) => ({ itemId: t.id, expression: expressions[i], explanation: "在新的图书馆语境中练习正确用法。" })) };
}
const results = (targets: PracticeTarget[], answer: string): PracticeFeedback => ({
  summary: "本次正确使用了相应表达，下次可以换个话题再练。", revisedAnswer: answer,
  results: targets.map((t) => ({ itemId: t.id, status: "secure", quote: t.kind === "grammar" ? "can help students" : "pay attention to", correction: "", explanation: "对应规则在作答中使用正确。" })),
});

test("notebook migration preserves version-1 data, is repeatable, and keeps the identity database unchanged", () => {
  const folder = mkdtempSync(join(tmpdir(), "cet-notebook-migration-"));
  const file = join(folder, "existing.sqlite");
  try {
    const old = new DatabaseSync(file);
    old.exec(initialSchema + "CREATE TABLE app_migrations(version INTEGER PRIMARY KEY); INSERT INTO app_migrations VALUES(1);");
    old.prepare("INSERT INTO users VALUES('owner','old@example.test','old','!synthetic','2026-10-01')").run();
    old.close();
    const identity = sqliteDatabase(file, { identityOnly: true });
    assert.equal(identity.sql.prepare("SELECT name FROM sqlite_master WHERE name='notebook_items'").get(), undefined);
    identity.sql.close();
    const upgraded = sqliteDatabase(file);
    assert.equal(upgraded.sql.prepare("SELECT email FROM users WHERE id='owner'").get()?.email, "old@example.test");
    assert.deepEqual(upgraded.sql.prepare("SELECT version FROM app_migrations ORDER BY version").all().map(row => row.version), [1, 2, 3]);
    upgraded.sql.close();
    const reopened = sqliteDatabase(file);
    assert.equal(reopened.sql.prepare("SELECT COUNT(*) AS n FROM notebook_items").get()?.n, 0);
    reopened.sql.close();
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("mistake extraction groups modal errors and excludes optional edits, unquoted corrections, and expression polish", () => {
  const input = makeInput("The library can helps students. Students could chooses useful books. We pay attentions to their needs. This helps over a term.");
  const report = { id: crypto.randomUUID(), createdAt: "2026-10-27", input, question, status: "completed", feedback: feedback(input) } as Review;
  report.feedback!.corrections.push(
    { original: "This helps over a term.", replacement: "This helps within a term.", kind: "clarity", reason: "原句语法正确，这是可选优化。" },
    { original: "I always makes progress.", replacement: "I always make progress.", kind: "grammar", reason: "主谓不一致，应使用 make。" },
  );
  report.feedback!.advancedSuggestions = [{ kind: "phrase", original: "over a term", replacement: "within a term", explanation: "可选进阶", example: "It helps within a term." }];
  const items = extractNotebookMistakes(report);
  assert.equal(items.length, 2);
  assert.equal(items.filter((i) => i.signature === "grammar:modal-base-verb").length, 1);
  assert.ok(items.some((i) => i.detail.right.includes("pay attention to")));
  assert.ok(items.every((i) => !i.detail.wrong.includes("term")));
});

test("model mistake highlights must quote an actual retained correction", () => {
  const input = makeInput();
  const raw = { ...feedback(input), diagnostics: [{ area: "语法", status: "priority", evidence: "can helps", advice: "使用原形" }], priorities: [{ title: "语法", reason: "存在词形错误", action: "改动词" }], notebookHighlights: [
    { correctionIndex: 0, wrong: "can helps", right: "can help", title: "情态动词后用原形", pattern: "modal + base verb" },
    { correctionIndex: 1, wrong: "fabricated quote", right: "choose", title: "虚构内容", pattern: "bad" },
  ] };
  const normalized = normalizeFeedback(raw, input, question);
  assert.equal(normalized.notebookHighlights?.length, 1);
  assert.equal(normalized.notebookHighlights?.[0].wrong, "can helps");
});

test("translation omissions and mistranslations retain verified Chinese source evidence", () => {
  const input = makeInput("The population is ten million.");
  const q = { ...question, task: "translation" as const, sourceText: "这个城市有一百万人口，每年吸引大量游客。" };
  const report = { id: crypto.randomUUID(), createdAt: "2026-10-28", input, question: q, status: "completed", feedback: { ...feedback(input), alignment: [
    { source: "一百万人口", student: "ten million", status: "mistranslated", explanation: "数字错译，一百万应为 one million。", suggestion: "one million people" },
    { source: "每年吸引大量游客", student: "", status: "missing", explanation: "遗漏了每年吸引游客这一信息。", suggestion: "attracts many tourists every year" },
    { source: "不存在的中文", student: "", status: "missing", explanation: "虚构的引用", suggestion: "not present" },
  ] } } as Review;
  const found = extractNotebookMistakes(report);
  assert.equal(found.length, 2);
  assert.ok(found.every((i) => i.evidence.source && q.sourceText.includes(i.evidence.source)));
  assert.ok(found.some((i) => i.detail.wrong.startsWith("漏译：")));
});

test("historical backfill includes more than 100 reviews, counts distinct reports, and reopens a newly recurring mastered error", async () => {
  const e = environment();
  try {
    const a = await e.register("notebook-backfill@example.test");
    let last: Review | null = null;
    for (let i = 0; i < 103; i++) last = e.seed(a.owner, makeInput(), new Date(Date.UTC(2026, 0, i + 1)).toISOString());
    const first = await getNotebookData(e.env, a.owner);
    assert.equal(first.reviewedCount, 103);
    assert.equal(first.items.length, 2);
    assert.ok(first.items.every((i) => i.occurrenceCount === 103));
    await syncNotebook(e.env, a.owner);
    await archiveReviewMistakes(e.env, a.owner, last!);
    const modal = first.items.find((i) => i.kind === "grammar")!;
    await updateNotebookItem(e.env, a.owner, modal.id, "mastered");
    assert.equal((await getNotebookData(e.env, a.owner)).items.find((i) => i.id === modal.id)?.status, "mastered");
    e.seed(a.owner, makeInput(), new Date(Date.now() + 2000).toISOString());
    const second = await getNotebookData(e.env, a.owner);
    assert.equal(second.items.find((i) => i.id === modal.id)?.status, "active");
    assert.equal(second.items.find((i) => i.id === modal.id)?.occurrenceCount, 104);
    await updateNotebookItem(e.env, a.owner, modal.id, "ignored");
    e.seed(a.owner, makeInput(), new Date(Date.now() + 4000).toISOString());
    assert.equal((await getNotebookData(e.env, a.owner)).items.find((i) => i.id === modal.id)?.status, "ignored");
  } finally { e.sql.close(); }
});

test("completed reviews archive immediately, while failed reviews do not create notebook entries", async () => {
  const e = environment();
  try {
    const a = await e.register("notebook-finish@example.test");
    const start = await beginReview(e.env, a.owner, makeInput(), crypto.randomUUID(), "synthetic-test");
    await finishReview(e.env, a.owner, start.review.id, feedback());
    assert.equal(e.sql.prepare("SELECT COUNT(*) AS n FROM notebook_items").get()?.n, 2);
    const failed = await beginReview(e.env, a.owner, makeInput(), crypto.randomUUID(), "synthetic-test");
    await finishReview(e.env, a.owner, failed.review.id, null, "Synthetic failure");
    assert.equal((await getNotebookData(e.env, a.owner)).reviewedCount, 1);
  } finally { e.sql.close(); }
});

test("notebook APIs enforce login, origin checks and account ownership", async () => {
  const e = environment();
  try {
    for (const [path, method] of [["/api/notebook", "GET"], ["/api/notebook/items", "PATCH"], ["/api/notebook/reveal", "POST"], ["/api/notebook/exercises", "POST"], ["/api/notebook/attempts", "POST"]]) {
      assert.equal((await e.request(path, method, method === "GET" ? undefined : {})).status, 401);
    }
    const a = await e.register("notebook-owner-a@example.test"), b = await e.register("notebook-owner-b@example.test");
    e.seed(a.owner);
    const list: NotebookData = await (await e.request("/api/notebook", "GET", undefined, a.cookie)).json();
    const other: NotebookData = await (await e.request("/api/notebook", "GET", undefined, b.cookie)).json();
    assert.equal(other.items.length, 0); assert.equal(other.reviewedCount, 0);
    assert.equal((await e.request("/api/notebook/items", "PATCH", { id: list.items[0].id, status: "mastered" }, b.cookie)).status, 404);
    assert.equal((await e.request("/api/notebook/items", "PATCH", { id: list.items[0].id, status: "mastered" }, a.cookie, "https://other.example")).status, 403);
    e.env.DEEPSEEK_API_KEY = "synthetic-key";
    const generation = { itemIds: [list.items[0].id], task: "translation", examType: "CET4", requestKey: crypto.randomUUID() };
    assert.equal((await e.request("/api/notebook/exercises", "POST", generation, b.cookie)).status, 404);
    assert.equal((await e.request("/api/notebook/exercises", "POST", { ...generation, itemIds: [list.items[0].id, list.items[0].id] }, a.cookie)).status, 400);
  } finally { e.sql.close(); }
});

test("one composite exercise covers selected mistakes, hides its solution and saves idempotent attempts across database reopen", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "cet-notebook-persistence-"));
  const file = join(directory, "practice.sqlite");
  const e = environment(file);
  try {
    const a = await e.register("notebook-practice@example.test"), b = await e.register("notebook-isolation@example.test");
    e.seed(a.owner);
    const book = await getNotebookData(e.env, a.owner);
    e.env.DEEPSEEK_API_KEY = "synthetic-key";
    let calls = 0;
    const answer = "The library can help students learn. Staff should pay attention to their needs.";
    t.mock.method(globalThis, "fetch", async (_url: unknown, options?: RequestInit) => {
      calls++;
      const body = JSON.parse(String(options?.body));
      const userData = JSON.parse(body.messages[1].content);
      return completion(userData.answer ? results(userData.targets, userData.answer) : content(userData.targets));
    });
    const data = { itemIds: book.items.map((i) => i.id), requestKey: crypto.randomUUID(), task: "translation", examType: "CET4" };
    const first = await e.request("/api/notebook/exercises", "POST", data, a.cookie);
    assert.equal(first.status, 200);
    const generated: NotebookExercise = (await first.json()).exercise;
    assert.equal(generated.targets.length, 2); assert.equal(generated.solution, null);
    assert.equal("referenceAnswer" in generated.content!, false);
    const replay = await e.request("/api/notebook/exercises", "POST", data, a.cookie);
    assert.equal((await replay.json()).exercise.id, generated.id); assert.equal(calls, 1);
    assert.equal((await e.request("/api/notebook/reveal", "POST", { id: generated.id }, b.cookie)).status, 404);
    const submission = { exerciseId: generated.id, requestKey: crypto.randomUUID(), answer };
    assert.equal((await e.request("/api/notebook/attempts", "POST", submission, b.cookie)).status, 404);
    const checked = await e.request("/api/notebook/attempts", "POST", submission, a.cookie);
    assert.equal(checked.status, 200);
    const completed: NotebookExercise = (await checked.json()).exercise;
    assert.equal(completed.attempts[0].answer, answer); assert.ok(completed.solution);
    assert.equal(completed.attempts[0].feedback?.results.length, 2);
    await e.request("/api/notebook/attempts", "POST", submission, a.cookie);
    assert.equal(calls, 2);
    const reloaded = await getNotebookData(e.env, a.owner);
    assert.equal(reloaded.exercises[0].attempts.length, 1);
    assert.equal(reloaded.items[0].status, "active");
    assert.equal((await getNotebookData(e.env, b.owner)).exercises.length, 0);
  } finally { e.sql.close(); }
  try {
    const reopened = sqliteDatabase(file);
    try {
      const owner = reopened.sql.prepare("SELECT id FROM users WHERE email='notebook-practice@example.test'").get()!.id as string;
      const restored = await getNotebookData({ ...e.env, DB: reopened.db }, owner);
      assert.equal(restored.exercises.length, 1);
      assert.equal(restored.exercises[0].attempts[0].status, "completed");
      assert.equal(restored.exercises[0].attempts[0].answer.includes("pay attention to"), true);
    } finally { reopened.sql.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("practice validation rejects uncovered targets and fabricated answer evidence", async () => {
  const targets: PracticeTarget[] = [
    { id: crypto.randomUUID(), kind: "grammar", title: "动词原形", wrong: "can helps", right: "can help", pattern: "modal + base verb", explanation: "情态动词后用原形" },
    { id: crypto.randomUUID(), kind: "vocabulary", title: "pay attention to", wrong: "pay attentions to", right: "pay attention to", pattern: "pay attention to", explanation: "固定搭配" },
  ];
  const env = { DEEPSEEK_API_KEY: "synthetic-key" };
  const valid = content(targets);
  assert.equal((await generateNotebookPractice(targets, "translation", "CET4", env, async () => completion(valid))).coverage.length, 2);
  for (const invalid of [
    { ...valid, coverage: valid.coverage.slice(0, 1) },
    { ...valid, coverage: valid.coverage.map((c) => ({ ...c, itemId: crypto.randomUUID() })) },
    { ...valid, coverage: valid.coverage.map((c) => ({ ...c, expression: "not present in the reference" })) },
  ]) await assert.rejects(generateNotebookPractice(targets, "translation", "CET4", env, async () => completion(invalid)), /未完整覆盖/);
  await assert.rejects(generateNotebookPractice(targets, "translation", "CET4", env, async () => completion(valid, "length")), /不完整/);
  const answer = valid.referenceAnswer;
  const bad = results(targets, answer); bad.results[0].quote = "fabricated answer text";
  await assert.rejects(checkNotebookPractice(answer, valid, targets, env, async () => completion(bad)), /证据无法核实/);
  const repeatedWrongAnswer = `${answer} But staff can helps students.`;
  const falseSecure = results(targets, repeatedWrongAnswer);
  await assert.rejects(checkNotebookPractice(repeatedWrongAnswer, valid, targets, env, async () => completion(falseSecure)), /证据无法核实/);
});

test("capitalization mistakes are archived and a correct capitalized answer can pass", async () => {
  const input = makeInput("Many people in china use libraries.");
  const report = { id: crypto.randomUUID(), status: "completed", createdAt: "2026-10-28", input, question, feedback: { ...feedback(input), corrections: [{ original: input.essay, replacement: "Many people in China use libraries.", reason: "国名 China 首字母应使用大写，原文拼写大小写有误。", kind: "vocabulary" }] } } as Review;
  assert.equal(extractNotebookMistakes(report).length, 1);
  const target: PracticeTarget = { id: crypto.randomUUID(), ...extractNotebookMistakes(report)[0].detail };
  const answer = "Many people in China use libraries.";
  const exercise: PracticeContent = { title: "图书馆", instruction: "翻译", prompt: "许多中国人使用图书馆。", referenceAnswer: answer, coverage: [{ itemId: target.id, expression: "China", explanation: "专名大写" }] };
  const checked = await checkNotebookPractice(answer, exercise, [target], { DEEPSEEK_API_KEY: "synthetic" }, async () => completion({ summary: "国名已正确大写。", revisedAnswer: answer, results: [{ itemId: target.id, status: "secure", quote: "China", correction: "", explanation: "首字母已正确大写。" }] }));
  assert.equal(checked.results[0].status, "secure");
});

test("interrupted jobs expire without losing the saved practice answer", async () => {
  const e = environment();
  try {
    const a = await e.register("notebook-timeout@example.test");
    const exerciseId = crypto.randomUUID(), attemptId = crypto.randomUUID();
    e.sql.prepare("INSERT INTO notebook_exercises(id,user_id,request_key,task,exam_type,status,targets,model,created_at) VALUES(?,?,?,'writing','CET4','completed','[]','synthetic','2020-01-01')").run(exerciseId, a.owner, crypto.randomUUID());
    e.sql.prepare("INSERT INTO notebook_attempts(id,user_id,exercise_id,request_key,answer,status,created_at) VALUES(?,?,?,?,?,'processing','2020-01-01')").run(attemptId, a.owner, exerciseId, crypto.randomUUID(), "Saved synthetic practice answer");
    await expireNotebookJobs(e.env, a.owner);
    const row = e.sql.prepare("SELECT status,answer FROM notebook_attempts WHERE id=?").get(attemptId)!;
    assert.equal(row.status, "failed"); assert.equal(row.answer, "Saved synthetic practice answer");
  } finally { e.sql.close(); }
});

test("teacher retrieves only the signed-in account's records, and disabling history omits them", async (t) => {
  const e = environment();
  try {
    const a = await e.register("teacher-history-a@example.test"), b = await e.register("teacher-history-b@example.test");
    e.seed(a.owner, { ...makeInput(), title: "MY_SYNTHETIC_RECORD_ONLY" });
    e.seed(b.owner, { ...makeInput(), title: "OTHER_ACCOUNT_SYNTHETIC_RECORD" });
    const history = await teacherHistory(e.env, a.owner, { messages: [{ role: "user", content: "根据我的记录总结反复出现的问题" }] });
    assert.ok(history.some((h) => h.reviewId));
    assert.ok(JSON.stringify(history).includes("MY_SYNTHETIC_RECORD_ONLY"));
    assert.ok(!JSON.stringify(history).includes("OTHER_ACCOUNT_SYNTHETIC_RECORD"));
    const overview = JSON.parse(history[0].text);
    assert.equal(overview.completedReviews, 1); assert.equal(overview.recurringMistakes.length, 2);
    e.env.DEEPSEEK_API_KEY = "synthetic-key";
    let captured: { kind: string; id: number; text: string; reviewId?: string }[] = [];
    t.mock.method(globalThis, "fetch", async (_url: unknown, options?: RequestInit) => {
      const body = JSON.parse(String(options?.body));
      captured = JSON.parse(body.messages[0].content.split("providedEvidence=")[1]);
      const ownRecord = captured.find((h) => h.reviewId);
      return completion({ answer: ownRecord ? `你多次练习的动词用法可以继续巩固[${ownRecord.id}]。` : "先整体定档，再结合具体证据说明[1]。" });
    });
    const withHistory = await e.request("/api/teacher", "POST", { messages: [{ role: "user", content: "查看我的记录" }] }, a.cookie);
    assert.equal(withHistory.status, 200);
    const reply = await withHistory.json(); assert.ok(reply.sources[0].reviewId);
    assert.ok(captured.some((h) => h.kind === "history"));
    await e.request("/api/teacher", "POST", { messages: [{ role: "user", content: "查看我的记录" }], includeHistory: false }, a.cookie);
    assert.ok(captured.every((h) => h.kind !== "history"));
  } finally { e.sql.close(); }
});

test("AI teacher UI defaults to private history access and identifies record-backed sources", () => {
  const html = renderToStaticMarkup(createElement(AITeacher, { user: { id: "synthetic", email: "example@example.test", name: "测试" }, configured: true, active: true, context: { questionId: question.id }, questionLabel: "测试题", onLogin() {}, onLibrary() {}, onReview() {}, onHistory() {} }));
  assert.match(html, /读取我的练习与批改/);
  assert.match(html, /仅当前账号的已保存记录/);
  assert.match(html, /默认|checked=""/);
  assert.ok(!html.includes("不会自动读取你的答案或批改报告"));
});
