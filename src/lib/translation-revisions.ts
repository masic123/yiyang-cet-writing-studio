import type { Feedback } from "./types";
import type { RevisionDocument } from "./revisions";

export const untranslatedSourceNotice = "对应中文原句暂未核实，请展开本次题目对照。";

type Span = { start: number; end: number };
type SourceSpan = Span & { text: string };

// A repeated English quote cannot identify which occurrence was assessed.
function uniqueSpan(text: string, quote: string): Span | null {
  if (!quote.trim()) return null;
  const start = text.indexOf(quote);
  return start < 0 || text.indexOf(quote, start + 1) >= 0
    ? null
    : { start, end: start + quote.length };
}

const overlaps = (a: Span, b: Span) => a.start < b.end && b.start < a.end;

export function withTranslationSources(
  document: RevisionDocument,
  essay: string,
  sourceText: string,
  feedback: Pick<Feedback, "alignment" | "scoringEvidence">,
): RevisionDocument {
  const sourceSentences: SourceSpan[] = Array.from(
    new Intl.Segmenter("zh-CN", { granularity: "sentence" }).segment(sourceText),
    entry => ({ start: entry.index, end: entry.index + entry.segment.length, text: entry.segment.trim() }),
  ).filter(s => s.text);
  // Prefer individual verified evidence quotes to an alignment spanning gaps.
  const checks = feedback.scoringEvidence?.taskChecks;
  const links = checks?.length
    ? checks.map(c => ({ source: c.requirement, evidence: c.evidence }))
    : feedback.alignment.filter(a => a.status !== "missing").map(a => ({ source: a.source, evidence: [a.student] }));
  const mapped = links.flatMap(link => {
    const source = uniqueSpan(sourceText, link.source);
    if (!source) return [];
    const sentences = sourceSentences.filter(s => overlaps(s, source));
    return link.evidence.flatMap(quote => {
      const target = uniqueSpan(essay, quote);
      return target ? [{ target, sentences }] : [];
    });
  });
  const sourcesFor = (target: Span) => [...new Set(
    mapped.filter(m => overlaps(m.target, target))
      .flatMap(m => m.sentences)
      .sort((a, b) => a.start - b.start)
      .map(s => s.text),
  )];
  const sentences = document.sentences.map(sentence => ({
    ...sentence,
    translationSources: sourcesFor(sentence),
  }));
  return {
    ...document,
    translation: true,
    sentences,
    paragraphs: document.paragraphs.map(paragraph => ({
      ...paragraph,
      sentences: sentences.filter(s => s.paragraph === paragraph.index),
    })),
    unplaced: document.unplaced.map(item => {
      const target = uniqueSpan(essay, item.correction.original);
      return { ...item, translationSources: target ? sourcesFor(target) : [] };
    }),
  };
}
