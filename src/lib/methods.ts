import type { MethodRule, Question } from "./types";
export const methodAppliesTo = (rule: MethodRule, q: Question) =>
  rule.task === "all" || rule.task === q.task;
export const methodSourceLabel = (rule: MethodRule) =>
  `${rule.source.kind === "official_summary" ? "官方要求摘要" : "基于官方要求的练习建议"} · 大纲 PDF 第 ${rule.source.page} 页 · ${rule.source.section}`;
