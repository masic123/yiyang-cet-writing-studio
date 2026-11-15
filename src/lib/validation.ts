import { z } from "zod";
const outlineSchema = z.object({
  analysis: z.string().max(2000),
  position: z.string().max(2000),
  paragraphs: z
    .array(
      z.object({
        id: z.string().min(1).max(100),
        point: z.string().max(2000),
        support: z.string().max(3000),
      }),
    )
    .max(8)
    .refine(
      (p) => new Set(p.map((v) => v.id)).size === p.length,
      "提纲编号重复。",
    ),
  ending: z.string().max(2000),
});
export const essaySchema = z
  .object({
    questionId: z.number().int().positive().nullable(),
    customQuestion: z
      .object({
        stem: z.string().trim().min(10, "请填写完整题目或翻译要求。").max(6000),
        sourceText: z.string().trim().max(10000),
        task: z.enum(["writing", "translation"]),
        examType: z.enum(["CET4", "CET6"]),
        needsVisual: z.boolean().default(false),
        visualDescription: z.string().max(6000).optional(),
        wordMin: z.number().int().min(1).max(1000).optional(),
        wordMax: z.number().int().min(1).max(2000).optional(),
      })
      .refine(
        (q) => q.task !== "translation" || q.sourceText.length >= 10,
        "翻译题需要填写完整中文原文。",
      )
      .refine(
        (q) => !q.wordMin || !q.wordMax || q.wordMax >= q.wordMin,
        "词数上限应不小于下限。",
      )
      .optional(),
    essay: z.string().max(30000, "正文最多支持 30000 个字符。"),
    outline: outlineSchema.optional(),
    targetScore: z.number().int().min(1).max(15),
    title: z.string().trim().max(120),
  })
  .refine(
    (v) => v.questionId !== null || !!v.customQuestion,
    "请选择或填写题目。",
  );
export const feedbackSchema = z.object({
  summary: z.string().min(10).max(3000),
  holisticScore: z.number().int().min(0).max(15).nullable(),
  scoreReason: z.string().min(10).max(3000),
  diagnostics: z
    .array(
      z.object({
        area: z.string().min(1).max(100),
        status: z.enum(["secure", "developing", "priority"]),
        evidence: z.string().max(1500),
        advice: z.string().max(2000),
      }),
    )
    .min(1)
    .max(5),
  strengths: z.array(z.string().max(1500)).max(5),
  priorities: z
    .array(
      z.object({
        title: z.string().max(200),
        reason: z.string().max(1500),
        action: z.string().max(1500),
      }),
    )
    .max(3),
  methodChecks: z
    .array(
      z.object({
        ruleId: z.string(),
        status: z.enum(["met", "partial", "missing", "not_applicable"]),
        evidence: z.string().max(1500),
        advice: z.string().max(1500),
      }),
    )
    .max(8),
  paragraphs: z
    .array(
      z.object({
        index: z.number().int().positive(),
        role: z.string().max(200),
        feedback: z.string().max(2000),
        suggestion: z.string().max(2500),
      }),
    )
    .max(40),
  corrections: z
    .array(
      z.object({
        original: z.string().min(1).max(1500),
        replacement: z.string().max(2000),
        reason: z.string().max(1500),
        kind: z.enum(["grammar", "vocabulary", "clarity", "logic", "accuracy"]),
      }),
    )
    .max(30),
  alignment: z
    .array(
      z.object({
        source: z.string().min(1).max(1200),
        student: z.string().max(2500),
        status: z.enum(["accurate", "partial", "missing", "mistranslated"]),
        explanation: z.string().max(1500),
        suggestion: z.string().max(2500),
      }),
    )
    .max(30),
  improvedEssay: z.string().min(30).max(18000),
  advancedSuggestions: z
    .array(
      z.object({
        kind: z.enum(["vocabulary", "phrase", "sentence"]),
        original: z.string().min(1).max(1500),
        replacement: z.string().min(1).max(2000),
        explanation: z.string().min(1).max(1500),
        example: z.string().min(1).max(2000),
      }),
    )
    .max(9)
    .default([]),
  notebookHighlights: z.array(z.object({
    correctionIndex: z.number().int().min(0).max(29),
    wrong: z.string().trim().min(1).max(240),
    right: z.string().trim().min(1).max(240),
    title: z.string().trim().min(1).max(120),
    pattern: z.string().trim().min(1).max(240),
  })).max(30).default([]),
  exercises: z
    .array(
      z.object({
        title: z.string().max(200),
        instruction: z.string().max(1500),
      }),
    )
    .max(4),
});

// Goal-aware teaching is validated separately and never part of a scoring schema.
export { targetCoachingContentSchema, targetCoachingSchema } from "./target-coaching-schema";
