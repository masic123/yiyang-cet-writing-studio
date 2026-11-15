import type { Feedback } from "./types";

export type Correction = Feedback["corrections"][number];
export const correctionLabels: Record<Correction["kind"], string> = {
  grammar: "语法",
  vocabulary: "用词建议",
  clarity: "表达建议",
  logic: "逻辑关系",
  accuracy: "原意传达",
};
export type DiffPart = { type: "same" | "removed" | "added"; text: string };
export type RevisionSentence = {
  id: string;
  paragraph: number;
  firstSentence: number;
  lastSentence: number;
  start: number;
  end: number;
  original: string;
  revised: string;
  corrections: Correction[];
  parts: DiffPart[];
  annotation: number | null;
  translationSources?: string[];
};
export type UnplacedCorrection = {
  correction: Correction;
  reason: "ambiguous" | "not_found" | "overlap" | "context";
  translationSources?: string[];
};
export type RevisionDocument = {
  translation?: boolean;
  paragraphs: { index: number; sentences: RevisionSentence[] }[];
  sentences: RevisionSentence[];
  unplaced: UnplacedCorrection[];
  correctionCount: number;
};

// Keep whitespace and punctuation so both sides can be reconstructed exactly.
export function diffWords(original: string, revised: string): DiffPart[] {
  const tokenize = (text: string) =>
    text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*|\s+|[^\p{L}\p{N}\s]/gu) ||
    [];
  const before = tokenize(original);
  const after = tokenize(revised);
  const parts: DiffPart[] = [];
  const append = (type: DiffPart["type"], text: string) => {
    if (!text) return;
    const last = parts.at(-1);
    if (last?.type === type) last.text += text;
    else parts.push({ type, text });
  };
  let prefix = 0;
  while (prefix < before.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]
  )
    suffix++;
  append("same", before.slice(0, prefix).join(""));
  const a = before.slice(prefix, before.length - suffix);
  const b = after.slice(prefix, after.length - suffix);
  // Bound work for unusually long unpunctuated essays; never truncate the text.
  if (a.length * b.length > 250_000) {
    append("removed", a.join(""));
    append("added", b.join(""));
  } else {
    const width = b.length + 1;
    const lengths = new Uint16Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--)
      for (let j = b.length - 1; j >= 0; j--)
        lengths[i * width + j] =
          a[i] === b[j]
            ? 1 + lengths[(i + 1) * width + j + 1]
            : Math.max(
                lengths[(i + 1) * width + j],
                lengths[i * width + j + 1],
              );
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        append("same", a[i++]);
        j++;
      } else if (
        i < a.length &&
        (j === b.length ||
          lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])
      )
        append("removed", a[i++]);
      else append("added", b[j++]);
    }
  }
  append("same", before.slice(before.length - suffix).join(""));
  return parts;
}

type SourceSentence = Omit<
  RevisionSentence,
  "revised" | "corrections" | "parts" | "annotation"
>;
function sourceSentences(essay: string): SourceSentence[] {
  const sentences: SourceSentence[] = [];
  const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  let paragraphStart = 0;
  let paragraph = 0;
  const addParagraph = (end: number) => {
    const text = essay.slice(paragraphStart, end);
    if (!text.trim()) return;
    paragraph++;
    let index = 0;
    for (const entry of segmenter.segment(text)) {
      if (!entry.segment.trim()) continue;
      const leading = entry.segment.length - entry.segment.trimStart().length;
      const start = paragraphStart + entry.index + leading;
      const end = start + entry.segment.trim().length;
      index++;
      sentences.push({
        id: `s${start}`,
        paragraph,
        firstSentence: index,
        lastSentence: index,
        start,
        end,
        original: essay.slice(start, end),
      });
    }
  };
  for (const match of essay.matchAll(/\r?\n[\t ]*\r?\n(?:[\t ]*\r?\n)*/g)) {
    addParagraph(match.index);
    paragraphStart = match.index + match[0].length;
  }
  addParagraph(essay.length);
  return sentences;
}

export function buildRevisions(
  essay: string,
  corrections: Correction[],
): RevisionDocument {
  const source = sourceSentences(essay);
  const unplaced: UnplacedCorrection[] = [];
  const located: {
    correction: Correction;
    start: number;
    end: number;
    first: number;
    last: number;
  }[] = [];
  const seen = new Set<string>();
  for (const correction of corrections) {
    const { original, replacement } = correction;
    const signature = JSON.stringify([original, replacement]);
    if (
      !original.trim() ||
      original.trim() === replacement.trim() ||
      seen.has(signature)
    )
      continue;
    seen.add(signature);
    const start = essay.indexOf(original);
    if (start < 0) {
      unplaced.push({ correction, reason: "not_found" });
      continue;
    }
    // A quote repeated in several places cannot be safely assigned to one of them.
    if (essay.indexOf(original, start + 1) >= 0) {
      unplaced.push({ correction, reason: "ambiguous" });
      continue;
    }
    const end = start + original.length;
    const first = source.findIndex((s) => s.start <= start && s.end > start);
    const last = source.findIndex((s) => s.start < end && s.end >= end);
    if (
      first < 0 ||
      last < 0 ||
      source[first].paragraph !== source[last].paragraph
    ) {
      unplaced.push({ correction, reason: "context" });
      continue;
    }
    located.push({ correction, start, end, first, last });
  }
  located.sort((a, b) => a.start - b.start || b.end - a.end);
  const accepted: typeof located = [];
  for (const edit of located) {
    if (accepted.length && edit.start < accepted.at(-1)!.end)
      unplaced.push({ correction: edit.correction, reason: "overlap" });
    else accepted.push(edit);
  }
  const sentences: RevisionSentence[] = [];
  let annotation = 0;
  for (let i = 0; i < source.length; i++) {
    let last = i;
    // Merge only when a quoted correction spans adjacent sentences.
    for (const edit of accepted)
      if (edit.first <= last && edit.last >= i)
        last = Math.max(last, edit.last);
    const edits = accepted.filter((e) => e.first >= i && e.last <= last);
    const start = source[i].start;
    const end = source[last].end;
    const original = essay.slice(start, end);
    let cursor = start;
    let revised = "";
    for (const edit of edits) {
      revised += essay.slice(cursor, edit.start) + edit.correction.replacement;
      cursor = edit.end;
    }
    revised += essay.slice(cursor, end);
    sentences.push({
      ...source[i],
      end,
      lastSentence: source[last].lastSentence,
      original,
      revised,
      corrections: edits.map((e) => e.correction),
      parts: diffWords(original, revised),
      annotation: edits.length ? ++annotation : null,
    });
    i = last;
  }
  return {
    sentences,
    paragraphs: [...new Set(sentences.map((s) => s.paragraph))].map(
      (index) => ({
        index,
        sentences: sentences.filter((s) => s.paragraph === index),
      }),
    ),
    unplaced,
    correctionCount: accepted.length + unplaced.length,
  };
}

export const sentenceLocation = (sentence: RevisionSentence) =>
  `第 ${sentence.paragraph} 段 · 第 ${sentence.firstSentence}${sentence.lastSentence === sentence.firstSentence ? "" : `-${sentence.lastSentence}`} 句`;

export function revisionText(document: RevisionDocument): string {
  const located = document.sentences
    .filter((s) => s.corrections.length)
    .map(
      (s) =>
        `${sentenceLocation(s)}\n${document.translation ? `中文原句：${s.translationSources?.join("\n") || "对应中文原句暂未核实，请展开本次题目对照。"}\n我的译句` : "原句"}：${s.original}\n修改后：${s.revised || "（建议删除）"}\n${s.corrections.map((c) => `${correctionLabels[c.kind]}：${c.reason}`).join("\n")}`,
    );
  const other = document.unplaced.map(
    ({ correction: c, translationSources }) =>
      `待核对的修改建议\n${document.translation ? `中文原句：${translationSources?.join("\n") || "对应中文原句暂未核实，请展开本次题目对照。"}\n我的译句` : "引用"}：${c.original}\n修改后：${c.replacement || "（建议删除）"}\n${correctionLabels[c.kind]}：${c.reason}`,
  );
  return [...located, ...other].join("\n\n") || "本次报告未列出逐句修改。";
}
