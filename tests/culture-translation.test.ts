import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cultureTranslations } from "../src/lib/culture-translation";
import { questions, resolveQuestion } from "../src/lib/content";
import { isSupplementaryQuestion, questionSessionLabel } from "../src/lib/types";
import { practiceSentences, sentenceGaps } from "../src/lib/sentence-practice";
import { materialBooks, parseMaterial, searchMaterial } from "../src/lib/reading-material";
import { teacherKnowledge } from "../src/lib/teacher";
import { staticAssets } from "../server/assets";

test("culture exercises resolve through the shared question bank without exposing reference answers", () => {
  const bank = questions(), culture = bank.filter(isSupplementaryQuestion);
  assert.ok(culture.length >= 2);
  assert.equal(culture.length, cultureTranslations.length);
  assert.equal(new Set(bank.map(question => question.id)).size, bank.length);
  for (const record of cultureTranslations) {
    const question = resolveQuestion({ questionId: record.id, essay: "", targetScore: 11, title: "" });
    assert.equal(question.task, "translation");
    assert.equal(question.sourceText, record.sourceText);
    assert.equal(question.wordLimit, null);
    assert.equal(question.session, "");
    assert.equal(question.sourceUrl, "");
    assert.ok(!("referenceTranslation" in question));
    assert.ok(!("sentences" in question));
    assert.match(questionSessionLabel(question), /补充题.*原创改编/);
    assert.ok(record.sourceChapter && record.sourcePages.length);
    assert.ok(record.sourcePages.every(page => Number.isInteger(page) && page > 0));
  }
  for (const topic of new Set(cultureTranslations.map(record => record.topic))) {
    assert.deepEqual(cultureTranslations.filter(record => record.topic === topic).map(record => record.examType).sort(), ["CET4", "CET6"]);
  }
});

test("culture sentence practice preserves the whole passage and reference translation", () => {
  const compact = (text: string) => text.replace(/\s+/g, "");
  for (const record of cultureTranslations) {
    const sentences = practiceSentences.filter(sentence => sentence.questionId === record.id);
    assert.ok(sentences.length);
    assert.equal(compact(sentences.map(sentence => sentence.chinese).join("")), compact(record.sourceText), String(record.id));
    assert.equal(compact(sentences.map(sentence => sentence.english).join(" ")), compact(record.referenceTranslation), String(record.id));
    assert.ok(sentences.every(sentence => sentence.corpus === "culture" && sentence.examType === record.examType));
    assert.ok(sentences.every(sentence => sentenceGaps(sentence.english).length >= 3));
  }
});

test("AI teacher keeps supplementary exercises distinct from past exams", () => {
  const record = cultureTranslations[0];
  const evidence = teacherKnowledge({ messages: [{ role: "user", content: "请解释当前翻译题目" }], context: { questionId: record.id } });
  const context = evidence.find(item => item.kind === "context")!;
  assert.match(context.note, /原创改编.*非真题/);
  assert.equal(context.url, null);
  const realQuestions = teacherKnowledge({ messages: [{ role: "user", content: "推荐四级翻译真题题目" }] }).filter(item => item.kind === "question");
  assert.ok(realQuestions.length);
  assert.ok(realQuestions.every(item => !item.note.includes("原创改编")));
  const supplementary = teacherKnowledge({ messages: [{ role: "user", content: "推荐四级中国文化补充题目" }] }).filter(item => item.kind === "question");
  assert.ok(supplementary.length);
  assert.ok(supplementary.every(item => item.note.includes("原创改编")));
});

test("culture vocabulary handbook loads under production asset rules and supports bilingual search", async () => {
  const source = readFileSync(new URL(`../public${materialBooks.culture.file}`, import.meta.url), "utf8");
  const book = parseMaterial(source, "culture");
  assert.ok(book.chapters.length > 1);
  const tables = book.chapters.flatMap(chapter => chapter.blocks.filter(block => block.type === "table"));
  assert.ok(tables.length);
  for (const table of tables) assert.ok(table.rows.every(row => row.length === table.headers.length));
  assert.ok(searchMaterial(book, "文化").length);
  const english = tables.flatMap(table => table.rows.flatMap(row => row)).find(value => /[A-Za-z]{5,}/.test(value))!;
  assert.ok(english);
  assert.ok(searchMaterial(book, english.match(/[A-Za-z]{5,}/)![0]).length);
  const assets = staticAssets(fileURLToPath(new URL("../public", import.meta.url)));
  const response = await assets.fetch(new Request(`https://example.test${materialBooks.culture.file}`));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), source);
});
