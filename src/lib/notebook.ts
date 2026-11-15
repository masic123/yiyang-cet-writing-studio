import { diffWords, type Correction } from "./revisions";
import type { Review } from "./types";
import type { MistakeDetail, MistakeEvidence } from "./notebook-types";

const normalize = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

// Legacy reports can contain optional stylistic edits among corrections.
// Be conservative: only actual, evidenced problems belong in a mistake book.
export function actualMistake(c: Correction) {
  if (!c.original.trim() || !c.replacement.trim() || c.original.replace(/\s+/g, " ").trim() === c.replacement.replace(/\s+/g, " ").trim()) return false;
  if (/(可选|可接受|并非错误|不是错误|不算错误|原(?:句|文|表达).{0,10}(?:正确|无误|没有问题)|语法(?:本身)?(?:正确|无误)|仅.{0,5}(?:润色|优化)|风格偏好|optional|stylistic)/i.test(c.reason)) return false;
  const concrete = /(错误|有误|误用|错用|错译|漏译|缺少|缺失|遗漏|不一致|不符|不能|不可|应(?:当)?(?:用|为|使用)|不(?:准确|成立|合语法|正确)|歧义|主谓|时态|单复数|拼写|词形|固定搭配|情态动词|介词搭配|语法问题|动词原形|第三人称|incorrect|error|agreement|misspell)/i;
  return concrete.test(c.reason);
}

const contextWords = (text: string) => text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) || [];

export function extractNotebookMistakes(review: Review): { signature: string; detail: MistakeDetail; evidence: MistakeEvidence }[] {
  if (review.status !== "completed" || !review.feedback) return [];
  const feedback = review.feedback;
  const found: ReturnType<typeof extractNotebookMistakes> = [];
  const seen = new Set<string>();
  feedback.corrections.forEach((c, index) => {
    if (!actualMistake(c) || !review.input.essay.includes(c.original)) return;
    const parts = diffWords(c.original, c.replacement);
    const changes: { wrong: string; right: string; before: string; after: string }[] = [];
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].type === "same") continue;
      const start = i;
      let wrong = "", right = "";
      while (i < parts.length && parts[i].type !== "same") {
        if (parts[i].type === "removed") wrong += parts[i].text;
        else right += parts[i].text;
        i++;
      }
      const before = parts[start - 1]?.type === "same" ? parts[start - 1].text : "";
      const after = parts[i]?.type === "same" ? parts[i].text : "";
      // Whitespace-only changes are not teachable expression errors.
      if (/[\p{L}\p{N}]/u.test(wrong + right)) changes.push({ wrong: wrong.trim(), right: right.trim(), before, after });
    }
    const highlights = feedback.notebookHighlights?.filter((h) => h.correctionIndex === index) || [];
    for (const change of changes) {
      const left = contextWords(change.before).slice(-2).join(" ");
      const rightContext = contextWords(change.after).slice(0, 2).join(" ");
      const wrong = [left, change.wrong, rightContext].filter(Boolean).join(" ").slice(0, 240);
      const right = [left, change.right, rightContext].filter(Boolean).join(" ").slice(0, 240);
      const modal = c.kind === "grammar" && /(?:情态动词|modal)/i.test(c.reason) && /\b(can|could|may|might|must|shall|should|will|would)\b/i.test(wrong);
      const highlight = highlights.find((h) => (!change.wrong || h.wrong.includes(change.wrong)) && (!change.right || h.right.includes(change.right)));
      // Keep nearby words for insertions/deletions: unrelated uses of "a", "to"
      // or a plural ending must not collapse into one recurring expression.
      const signature = modal ? "grammar:modal-base-verb" :
        `${c.kind}:${normalize([contextWords(change.before).at(-1), change.wrong, contextWords(change.after)[0]].filter(Boolean).join(" "))}=>${normalize([contextWords(change.before).at(-1), change.right, contextWords(change.after)[0]].filter(Boolean).join(" "))}`;
      if (seen.has(signature)) continue;
      seen.add(signature);
      found.push({
        signature,
        detail: {
          kind: c.kind,
          title: modal ? "情态动词后用动词原形" : highlight?.title || right || wrong,
          pattern: modal ? "modal + base verb" : highlight?.pattern || right,
          wrong: highlight?.wrong || wrong,
          right: highlight?.right || right,
          explanation: c.reason,
        },
        evidence: {
          reviewId: review.id, createdAt: review.createdAt,
          question: review.input.title || review.question.name,
          examType: review.question.examType, task: review.question.task,
          original: c.original, replacement: c.replacement, reason: c.reason,
        },
      });
    }
  });
  if (review.question.task === "translation") {
    for (const a of feedback.alignment) {
      if (!["missing", "mistranslated"].includes(a.status) || !review.question.sourceText.includes(a.source) || !a.suggestion.trim()) continue;
      if (a.student && !review.input.essay.includes(a.student)) continue;
      if (a.status !== "missing" && (!a.student.trim() || normalize(a.student) === normalize(a.suggestion))) continue;
      // A correction and an alignment can describe the same error. Keep one source.
      if (found.some((f) => a.student && (f.evidence.original.includes(a.student) || a.student.includes(f.evidence.original)))) continue;
      const signature = `accuracy:${a.status}:${normalize(a.source)}`;
      if (seen.has(signature)) continue;
      seen.add(signature);
      found.push({
        signature,
        detail: { kind: "accuracy", title: `${a.status === "missing" ? "补全原意" : "准确传达"}：${a.source.slice(0, 65)}`, pattern: a.suggestion.slice(0, 240), wrong: a.student || `漏译：${a.source}`, right: a.suggestion.slice(0, 240), explanation: a.explanation },
        evidence: { reviewId: review.id, createdAt: review.createdAt, question: review.input.title || review.question.name, examType: review.question.examType, task: review.question.task, original: a.student || "（此处漏译）", replacement: a.suggestion, reason: a.explanation, source: a.source },
      });
    }
  }
  return found;
}
