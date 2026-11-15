import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildRevisions,
  diffWords,
  revisionText,
  type Correction,
} from "../src/lib/revisions";
import {
  AnnotatedOriginal,
  SentenceRevisions,
} from "../src/components/sentence-revisions";
import ExpressionSuggestions from "../src/components/expression-suggestions";

const correction = (original: string, replacement: string): Correction => ({
  original,
  replacement,
  reason: "检查主谓一致。",
  kind: "grammar",
});

test("word changes preserve the exact original and revised text, including punctuation and additions", () => {
  const pairs = [
    ["People is more happy.", "People are happier."],
    ["Housing rose by 1.5% in the U.K.", "Housing rose by 2.5% in the U.K."],
    ["I agree.", "I partly agree."],
    ["It is very very useful.", "It is useful."],
    ["We don't need it.", "We do not need it."],
    ["😀 This works!", "😀 This also works!"],
    ["One  space.", "One space."],
    ["", "New text."],
    ["Remove me.", ""],
    ["Unchanged.", "Unchanged."],
  ];
  for (const [before, after] of pairs) {
    const parts = diffWords(before, after);
    assert.equal(
      parts
        .filter((p) => p.type !== "added")
        .map((p) => p.text)
        .join(""),
      before,
    );
    assert.equal(
      parts
        .filter((p) => p.type !== "removed")
        .map((p) => p.text)
        .join(""),
      after,
    );
  }
  const diff = diffWords("People is happy.", "People are happy.");
  assert.deepEqual(
    diff.filter((p) => p.type !== "same"),
    [
      { type: "removed", text: "is" },
      { type: "added", text: "are" },
    ],
  );
  // The bounded fallback also preserves both sides of very long sentences.
  const long = diffWords("before ".repeat(600), "after ".repeat(600));
  assert.equal(
    long
      .filter((p) => p.type !== "added")
      .map((p) => p.text)
      .join(""),
    "before ".repeat(600),
  );
});

test("legacy phrase corrections expand to full sentences and combine non-overlapping edits", () => {
  const essay =
    "Housing matters. People is more happy in city.\r\n\r\nRent is high. Transport helps.";
  const document = buildRevisions(essay, [
    correction("People is", "People are"),
    correction("in city", "in cities"),
    correction("Rent is high.", "Rent is too high."),
  ]);
  assert.equal(document.paragraphs.length, 2);
  assert.equal(document.sentences.length, 4);
  assert.equal(document.correctionCount, 3);
  assert.equal(document.unplaced.length, 0);
  assert.equal(document.sentences[1].original, "People is more happy in city.");
  assert.equal(
    document.sentences[1].revised,
    "People are more happy in cities.",
  );
  assert.equal(document.sentences[1].corrections.length, 2);
  assert.equal(document.sentences[1].firstSentence, 2);
  assert.equal(document.sentences[2].paragraph, 2);
  for (const sentence of document.sentences)
    assert.equal(essay.slice(sentence.start, sentence.end), sentence.original);
  assert.ok(
    revisionText(document).includes("原句：People is more happy in city."),
  );
  assert.ok(
    revisionText(document).includes("修改后：People are more happy in cities."),
  );
});

test("ambiguous quotes and overlapping changes are shown separately instead of applied to the wrong place", () => {
  const document = buildRevisions(
    "Rent is high. Rent is high. Homes are scarce.",
    [
      correction("Rent is high.", "Rent is expensive."),
      correction("Homes are scarce.", "Affordable homes are scarce."),
      correction("Homes", "Houses"),
      correction("Not in this essay.", "Invented."),
      correction("Homes are scarce.", "Affordable homes are scarce."),
    ],
  );
  assert.equal(document.sentences[0].revised, "Rent is high.");
  assert.equal(document.sentences[1].revised, "Rent is high.");
  assert.equal(document.sentences[2].revised, "Affordable homes are scarce.");
  assert.deepEqual(document.unplaced.map((c) => c.reason).sort(), [
    "ambiguous",
    "not_found",
    "overlap",
  ]);
  assert.equal(document.correctionCount, 4);
});

test("cross-sentence corrections keep all context while paragraph-spanning and no-op edits are not applied", () => {
  const document = buildRevisions(
    "Rent rose. People moved.\n\nMore homes help.",
    [
      correction("Rent rose. People moved.", "As rent rose, people moved."),
      correction("People moved.\n\nMore homes", "People left. New homes"),
      correction("help", "help"),
    ],
  );
  assert.equal(document.sentences.length, 2);
  assert.equal(document.sentences[0].lastSentence, 2);
  assert.equal(document.sentences[0].revised, "As rent rose, people moved.");
  assert.equal(document.unplaced[0].reason, "context");
  assert.equal(document.sentences[1].revised, "More homes help.");
});

test("sentence UI marks changed words, keeps unchanged words readable and exposes annotation links", () => {
  const essay = "Housing matters. People is happy.";
  const document = buildRevisions(essay, [
    correction("People is happy.", "People are happy."),
  ]);
  const html = renderToStaticMarkup(
    createElement(SentenceRevisions, {
      document,
      activeId: null,
      onLocate: () => {},
      onDownload: () => {},
    }),
  );
  assert.ok(html.includes('class="revision-removed">is</mark>'));
  assert.ok(html.includes('class="revision-added">are</mark>'));
  assert.ok(html.includes("为什么改"));
  assert.ok(!html.includes("text-decoration:line-through"));
  const annotated = renderToStaticMarkup(
    createElement(AnnotatedOriginal, {
      document,
      essay,
      activeId: null,
      onOpen: () => {},
      onDownload: () => {},
    }),
  );
  assert.ok(annotated.includes("Housing matters."));
  assert.ok(annotated.includes("查看“is”的修改"));
  assert.ok(annotated.includes('id="source-s17"'));
});

test("a report without sentence corrections does not claim the essay is error-free", () => {
  const document = buildRevisions("This is an essay.", []);
  const html = renderToStaticMarkup(
    createElement(SentenceRevisions, {
      document,
      activeId: null,
      onLocate: () => {},
      onDownload: () => {},
    }),
  );
  assert.ok(html.includes("本次报告未列出可定位的逐句修改"));
  assert.ok(html.includes("未标注不代表句子已确认无误"));
});

test("expression practice is optional, grouped by usage and hidden on older reports", () => {
  const html = renderToStaticMarkup(createElement(ExpressionSuggestions, {
    suggestions: [{
      kind: "phrase",
      original: "make campus life easier",
      replacement: "improve campus life",
      explanation: "原表达正确；简洁替换属于可选练习。",
      example: "Clear service information can improve campus life.",
    }],
  }));
  assert.ok(html.includes("短语与搭配"));
  assert.ok(html.includes("用法例句"));
  assert.ok(html.includes("不计为错误，也不保证加分"));
  assert.ok(!html.includes("句式练习"));
  assert.equal(renderToStaticMarkup(createElement(ExpressionSuggestions, {})), "");
});
