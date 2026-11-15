import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { sqliteDatabase } from "../server/database";
import { questions } from "../src/lib/content";
import { getQuestionStats, finishReviewAccounting } from "../worker/leaderboard";
import { QuestionStatsLine } from "../src/components/question-stats";
import worker from "../worker/index";
import type { Env } from "../worker/types";

const SCORE_KEY = "holisticScore", SCORE = 10, MAX = 15;
function fixture() {
  const { sql, db } = sqliteDatabase(":memory:");
  const env = { DB: db, ASSETS: { fetch: async () => new Response("asset") } } as Env;
  const questionId = questions()[0].id, otherId = questions()[1].id;
  for (const id of ["one", "two"]) sql.prepare("INSERT INTO users(id,name,email,password,created_at) VALUES(?,?,?,?,?)").run(id, "Private learner " + id, id + "@example.test", "unused", "2026-10-01T00:00:00.000Z");
  function review(id: string, owner: string, score: number | null, options: { questionId?: number | null; status?: string; scope?: string; date?: string; malformed?: boolean } = {}) {
    const q = options.questionId === undefined ? questionId : options.questionId;
    sql.prepare("INSERT INTO reviews(id,user_id,input,question,status,feedback,model,refs,request_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, owner, options.malformed ? "invalid json" : JSON.stringify({ questionId: q, essay: "Private answer " + id }), JSON.stringify({ id: q, stem: "Private prompt" }), options.status || "completed", JSON.stringify({ [SCORE_KEY]: score, assessmentScope: options.scope || "full" }), "test", "[]", id, options.date || "2026-10-29T00:00:00.000Z");
  }
  return { sql, env, questionId, otherId, review };
}

test("question statistics count people once and average only each person's first scored submission", async t => {
  const f = fixture(); t.after(() => f.sql.close());
  f.review("first", "one", SCORE, { date: "2026-10-28T00:00:00.000Z" });
  f.review("improved", "one", MAX);
  f.review("duplicate", "one", MAX);
  f.review("zero", "two", 0);
  f.review("other-question", "one", MAX, { questionId: f.otherId });
  const data = await getQuestionStats(f.env);
  assert.equal(data.maxScore, MAX);
  assert.deepEqual(data.stats.find(s => s.questionId === f.questionId), { questionId: f.questionId, participants: 2, averageScore: SCORE / 2 });
  assert.deepEqual(data.stats.find(s => s.questionId === f.otherId), { questionId: f.otherId, participants: 1, averageScore: MAX });
  for (const privateValue of ["Private", "example.test", "user_id", "improved", '"one"']) assert.ok(!JSON.stringify(data).includes(privateValue));
  assert.deepEqual(await getQuestionStats(f.env), data);
});

test("failed, pending, unscored, limited, malformed and custom reviews do not supply a first score", async t => {
  const f = fixture(); t.after(() => f.sql.close());
  f.review("failed", "one", MAX, { status: "failed", date: "2026-10-01T00:00:00.000Z" });
  f.review("pending", "one", MAX, { status: "processing" });
  f.review("limited", "one", MAX, { scope: "language_only", date: "2026-10-02T00:00:00.000Z" });
  f.review("unscored", "one", null, { date: "2026-10-03T00:00:00.000Z" });
  f.review("invalid-score", "one", 99);
  f.review("custom", "one", MAX, { questionId: null });
  f.review("unknown", "one", MAX, { questionId: 999999999 });
  f.review("malformed", "one", MAX, { malformed: true });
  f.review("valid", "one", SCORE);
  assert.deepEqual((await getQuestionStats(f.env)).stats, [{ questionId: f.questionId, participants: 1, averageScore: SCORE }]);
});

test("submission order controls the first score even when reviews finish in reverse order", async t => {
  const f = fixture(); t.after(() => f.sql.close());
  f.review("earlier", "one", null, { status: "processing", date: "2026-10-28T00:00:00.000Z" });
  f.review("later", "one", MAX);
  assert.equal((await getQuestionStats(f.env)).stats[0].averageScore, MAX);
  await finishReviewAccounting(f.env, "one", "earlier", { [SCORE_KEY]: SCORE, assessmentScope: "full" });
  assert.deepEqual((await getQuestionStats(f.env)).stats, [{ questionId: f.questionId, participants: 1, averageScore: SCORE }]);
});

test("anonymous stats endpoint is read-only and empty statistics remain distinct from loading or failure", async t => {
  const f = fixture(); t.after(() => f.sql.close());
  const request = new Request("https://writing.example/api/question-stats");
  const response = await worker.fetch(request, f.env);
  assert.equal(response.status, 200); assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), { stats: [], maxScore: MAX });
  assert.equal((await worker.fetch(new Request(request.url, { method: "POST" }), f.env)).status, 405);
  const display = (loaded: boolean, error = false, zero = false) => renderToStaticMarkup(createElement(QuestionStatsLine, { loaded, error, maxScore: MAX, stat: zero ? { questionId: f.questionId, participants: 1, averageScore: 0 } : undefined }));
  assert.match(display(true), /0<\/b> 人写过/); assert.match(display(true), /暂无均分/);
  assert.match(display(true, false, true), /0\.0/);
  assert.match(display(false), /正在加载/); assert.match(display(false, true), /统计暂不可用/);
  assert.ok(!display(false, true).includes("人写过"));
});

