import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Report from "../src/components/report";
import type { Feedback, Review } from "../src/lib/types";

const withheldRevision = "UNCHECKED CANDIDATE CONTENT MUST NOT BE PUBLISHED.";
const originalSummary = "原作答的已核实评分与批改反馈仍可查看。";

function feedback(status: "checked" | "unverified"): Feedback {
  return {
    holisticScore: 11,
    bandRange: "10-12",
    assessmentScope: "full",
    summary: originalSummary,
    scoreReason: "依据原作答的实际表现进行整体评价。",
    diagnostics: [],
    strengths: [],
    priorities: [],
    methodChecks: [],
    paragraphs: [],
    corrections: [],
    alignment: [],
    improvedEssay: status === "unverified"
      ? withheldRevision
      : "Research projects help students learn to compare evidence.",
    exercises: [],
    revisionAssessment: {
      status,
      holisticScore: status === "checked" ? 14 : null,
      bandRange: status === "checked" ? "13-15" : null,
      summary: status === "checked" ? "修改稿已完成复核。" : "修改稿未完成复核。",
      remainingIssues: [],
    },
  };
}

function review(result: Feedback | null, error: string | null = null): Review {
  return {
    id: "synthetic-report",
    draftId: null,
    status: result ? "completed" : "failed",
    createdAt: "2026-11-02T01:00:00.000Z",
    input: {
      questionId: 1,
      essay: "Research projects give students opportunities to examine evidence.",
      title: "合成报告展示测试",
      targetScore: 11,
    },
    question: {
      id: 1,
      name: "合成报告展示测试",
      examType: "CET4",
      task: "writing",
      session: "",
      set: 1,
      category: "建议",
      topic: "研究项目",
      stem: "Discuss the benefits of research projects.",
      sourceText: "",
      wordLimit: { min: 40, max: 180 },
      timeLimit: 30,
      sourceType: "custom",
      sourceUrl: "",
      images: [],
      needsVisual: false,
      transcriptionStatus: "verified",
    },
    feedback: result,
    error,
    model: "synthetic-only",
    references: [],
  };
}

function render(value: Review) {
  return renderToStaticMarkup(createElement(Report, {
    review: value,
    onBack() {},
    onRewrite() {},
  }));
}

test("unverified revisions show a clear notice while retaining the original report, even with a stale candidate body", () => {
  const html = render(review(feedback("unverified")));
  assert.match(html, /完整修改稿暂未提供/);
  assert.match(html, /原作答的评分与批改反馈已保留/);
  assert.ok(html.includes(originalSummary));
  assert.match(html, /AI 整体参考分/);
  assert.match(html, /导出报告/);
  assert.ok(!html.includes(withheldRevision));
  assert.ok(!html.includes("UNCHECKED"));
});

test("checked revisions do not display the unavailable-revision notice", () => {
  const html = render(review(feedback("checked")));
  assert.ok(html.includes(originalSummary));
  assert.match(html, /完整修改稿/);
  assert.doesNotMatch(html, /完整修改稿暂未提供|原作答的评分与批改反馈已保留/);
});

test("legacy failed reports replace internal scoring diagnostics with a friendly retry message", () => {
  const diagnostic = "评分复核未通过：作答B给11分却没有可核实的实质问题，须依据实际表现重新定档或给真实证据。草稿已保留，本次不提供未经核实的分数。";
  const html = render(review(null, diagnostic));
  assert.match(html, /本次评分复核未完成，草稿已保留，请稍后重试。/);
  assert.match(html, /回到正文重试/);
  assert.doesNotMatch(html, /作答B|给11分|重新定档|可核实的实质问题/);
  assert.ok(!html.includes(diagnostic));
});

test("failed reports preserve unrelated actionable business errors", () => {
  const message = "今日免费批改和试用次数已用完，可开通会员继续批改。";
  const html = render(review(null, message));
  assert.ok(html.includes(message));
  assert.doesNotMatch(html, /本次评分复核未完成/);
});
