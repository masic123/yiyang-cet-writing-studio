import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildRevisions, revisionText, type Correction } from "../src/lib/revisions";
import { withTranslationSources, untranslatedSourceNotice } from "../src/lib/translation-revisions";
import { SentenceRevisions } from "../src/components/sentence-revisions";
import type { Feedback } from "../src/lib/types";

const correction = (original: string, replacement: string): Correction => ({
  original, replacement, kind: "grammar", reason: "复数主语应使用动词原形。",
});
const alignment = (source: string, student: string): Feedback["alignment"][number] => ({
  source, student, status: "accurate", explanation: "对应本句实际内容。", suggestion: "",
});
const render = (document: ReturnType<typeof buildRevisions>) => renderToStaticMarkup(createElement(SentenceRevisions, {
  document, activeId: null, onLocate() {}, onDownload() {},
}));

test("translation corrections display the corresponding Chinese sentence inside each card, including reordered translations and downloads", () => {
  const first = "学校每年组织文化活动。", second = "学生通过项目学习本地传统。";
  const a = "Students learns about local traditions through projects.";
  const b = "The school organizes cultural activities every year.";
  const essay = `${a} ${b}`;
  const document = withTranslationSources(buildRevisions(essay, [correction(a, a.replace("learns", "learn"))]), essay, first + second, {
    alignment: [alignment(first, b), alignment(second, a)],
  });
  assert.deepEqual(document.sentences.map(s => s.translationSources), [[second], [first]]);
  assert.equal(document.paragraphs[0].sentences[0], document.sentences[0]);
  const html = render(document);
  const card = html.slice(html.indexOf('<article'), html.indexOf('</article>'));
  assert.ok(card.includes(second)); assert.ok(!card.includes(first));
  assert.ok(card.indexOf("中文原句") < card.indexOf("我的译句"));
  assert.ok(card.indexOf("我的译句") < card.indexOf("修改后"));
  assert.ok(card.includes("为什么改"));
  const download = revisionText(document);
  assert.ok(download.includes(`中文原句：${second}\n我的译句：${a}`));
  assert.ok(!download.includes(first));
});

test("split and merged translations retain complete Chinese sentences in source order without duplicates", () => {
  const source = "这座图书馆建于1985年，每年举办多种文化活动。学生可以免费参加。";
  const a = "The library was built in 1985.", b = "It hosts cultural activities every year.";
  const essay = `${a} ${b}`;
  const document = withTranslationSources(buildRevisions(essay, []), essay, source, { alignment: [
    alignment("每年举办多种文化活动。", b), alignment("这座图书馆建于1985年", a), alignment("学生可以免费参加。", b),
  ] });
  assert.deepEqual(document.sentences[0].translationSources, ["这座图书馆建于1985年，每年举办多种文化活动。"]);
  assert.deepEqual(document.sentences[1].translationSources, ["这座图书馆建于1985年，每年举办多种文化活动。", "学生可以免费参加。"]);
});

test("verified separate evidence quotes avoid attaching Chinese text to unrelated sentences between them", () => {
  const source = "活动覆盖多种传统。图书馆免费开放。";
  const a = "The activities cover dance.", b = "The library is free.", c = "They also cover music.";
  const essay = `${a} ${b} ${c}`;
  const document = withTranslationSources(buildRevisions(essay, []), essay, source, {
    alignment: [alignment("活动覆盖多种传统。", essay)],
    scoringEvidence: { findings: [], taskChecks: [
      { requirement: "活动覆盖多种传统。", status: "met", evidence: [a, c], explanation: "跨句表达。" },
      { requirement: "图书馆免费开放。", status: "met", evidence: [b], explanation: "完整表达。" },
    ] },
  });
  assert.deepEqual(document.sentences.map(s => s.translationSources), [["活动覆盖多种传统。"], ["图书馆免费开放。"], ["活动覆盖多种传统。"]]);
});

test("unverified quotes and omitted Chinese content are never guessed from sentence positions", () => {
  const source = "学生学习传统。图书馆免费开放。";
  const essay = "Students learns traditions.";
  const document = withTranslationSources(buildRevisions(essay, [correction(essay, "Students learn traditions.")]), essay, source, { alignment: [
    alignment("学生学习传统。", "Invented English quote."),
    alignment("Invented Chinese quote.", essay),
    { ...alignment("图书馆免费开放。", ""), status: "missing" },
  ] });
  assert.deepEqual(document.sentences[0].translationSources, []);
  assert.ok(render(document).includes(untranslatedSourceNotice));
  assert.ok(revisionText(document).includes(untranslatedSourceNotice));
  assert.ok(!render(document).includes(source));
});

test("repeated English quotations remain explicitly unverified instead of assigning a Chinese sentence to the wrong occurrence", () => {
  const essay = "Students learns traditions. Students learns traditions.";
  const document = withTranslationSources(buildRevisions(essay, [correction("Students learns traditions.", "Students learn traditions.")]), essay, "学生学习传统。", {
    alignment: [alignment("学生学习传统。", "Students learns traditions.")],
  });
  assert.equal(document.unplaced.length, 1);
  assert.deepEqual(document.unplaced[0].translationSources, []);
  assert.ok(render(document).includes(untranslatedSourceNotice));
});

test("legacy phrase quotes use the original Chinese sentence, preserving numbers, punctuation and quotation marks", () => {
  const source = "当地人说：“2026年共有15个社区参加活动。”活动很受欢迎。";
  const essay = "There is 15 communities at the event.";
  const document = withTranslationSources(buildRevisions(essay, [correction("There is", "There are")]), essay, source, { alignment: [
    alignment("2026年共有15个社区参加活动。", "15 communities"),
  ] });
  assert.deepEqual(document.sentences[0].translationSources, ["当地人说：“2026年共有15个社区参加活动。”"]);
  assert.ok(revisionText(document).includes("2026年共有15个社区参加活动。"));
});

test("writing reports retain their original sentence labels and download format", () => {
  const document = buildRevisions("Students learns traditions.", [correction("Students learns", "Students learn")]);
  const html = render(document);
  assert.ok(html.includes("原句"));
  assert.ok(!html.includes("中文原句"));
  assert.ok(!html.includes("我的译句"));
  assert.ok(revisionText(document).includes("原句：Students learns traditions."));
});
