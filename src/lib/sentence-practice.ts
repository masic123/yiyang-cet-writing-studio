import groups from "../../data/translation-sentences.json";
import { cultureTranslations } from "./culture-translation";
import type { ExamLevel } from "./types";

export type PracticeSentence = { id: string; questionId: number; examType: ExamLevel; session: string; set: number; topic: string; sourceUrl: string; chinese: string; english: string; corpus: "past" | "culture" };
export const practiceSentences: PracticeSentence[] = [
  ...groups.flatMap(group => group.sentences.map(([chinese, english], index) => ({
    ...group, examType: group.examType as ExamLevel, sentences: undefined, id: `${group.questionId}-${index + 1}`, chinese, english, corpus: "past" as const,
  }))),
  ...cultureTranslations.flatMap((record, groupIndex) => record.sentences.map(([chinese, english], index) => ({
    id: `${record.id}-${index + 1}`, questionId: record.id, examType: record.examType, session: "", set: groupIndex + 1,
    topic: record.topic, sourceUrl: "", chinese, english, corpus: "culture" as const,
  }))),
];
const common = new Set("a an the of in on at to for from by with and or but as is are was were be been being that this these those it its they their them he his she her we our you your which who can could will would may might has have had do does did".split(" "));
const flexible = new Set([...common, ..."not only also more most much very than such some any every each all both many other between through during over under about into out up down so then when while how since before after still even already now just often usually especially help helps make makes made making allow allows enable enables".split(" ")]);
export type SentenceToken = { text: string; gap: number | null; word: boolean };
export const normalizeWord = (word: string) => word.normalize("NFKC").replace(/[’‘]/g, "'").replace(/[‐‑–]/g, "-").trim().toLowerCase();
export function sentenceTokens(english: string, seed?: string): SentenceToken[] {
  const words = [...english.matchAll(/[A-Za-z]+(?:['’\-][A-Za-z]+)*|\d+(?:[,.]\d+)*/g)];
  const candidates = words.flatMap((word, i) => (seed ? flexible : common).has(word[0].toLowerCase()) ? [i] : []);
  const hints = new Set<number>();
  const count = Math.min(seed && candidates.length > 1 ? candidates.length - 1 : candidates.length, 6, Math.max(1, Math.floor(words.length * .22)));
  if (seed) {
    let state = 2166136261;
    for (const char of seed) state = Math.imul(state ^ char.charCodeAt(0), 16777619) >>> 0;
    const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
    for (let i = candidates.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [candidates[i], candidates[j]] = [candidates[j], candidates[i]]; }
    for (const index of candidates.slice(0, count)) hints.add(index);
  } else {
    // Existing open pages can still submit their original deterministic blanks.
    for (let i = 0; i < count; i++) hints.add(candidates[Math.floor((i + .5) * candidates.length / count)]);
  }
  const tokens: SentenceToken[] = []; let offset = 0, gap = 0;
  words.forEach((word, index) => {
    if (word.index! > offset) tokens.push({ text: english.slice(offset, word.index), gap: null, word: false });
    tokens.push({ text: word[0], gap: hints.has(index) ? null : gap++, word: true });
    offset = word.index! + word[0].length;
  });
  if (offset < english.length) tokens.push({ text: english.slice(offset), gap: null, word: false });
  return tokens;
}
export const sentenceGaps = (english: string, seed?: string) => sentenceTokens(english, seed).filter(token => token.gap !== null).map(token => token.text);
export const sentenceHintSignature = (english: string, seed?: string) => sentenceTokens(english, seed).filter(token => token.word && token.gap === null).map(token => normalizeWord(token.text)).sort().join("|");
export const wordMatches = (answer: string, expected: string) => normalizeWord(answer) === normalizeWord(expected);
