import type { TeacherInput } from "../src/lib/teacher";
import type { TeacherHistoryEvidence } from "../src/lib/teacher-types";
import type { EssayInput, Feedback, Question } from "../src/lib/types";
import { levelLabel, taskLabel } from "../src/lib/types";
import { listNotebookItems, syncNotebook } from "./notebook";
import type { Env } from "./types";

type Row = Record<string, unknown>;
function keywords(input: TeacherInput) {
  const query = input.messages.filter((m) => m.role === "user").slice(-2).map((m) => m.content).join(" ").toLowerCase();
  const terms = query.match(/[a-z]{3,}|20\d{2}|[\u4e00-\u9fff]{2,}/g) || [];
  const result: string[] = [];
  for (const term of terms) {
    if (/^[\u4e00-\u9fff]+$/.test(term)) for (let i = 0; i < term.length - 1; i++) result.push(term.slice(i, i + 2));
    else result.push(term);
  }
  return [...new Set(result)].filter((s) => !["我的", "记录", "什么", "哪些", "一下", "可以", "帮我", "目前", "现在", "作文", "写作", "翻译"].includes(s)).slice(0, 16);
}

/** Called only after requireUser. No owner IDs or history documents come from the client. */
export async function teacherHistory(env: Env, owner: string, input: TeacherInput): Promise<TeacherHistoryEvidence[]> {
  await syncNotebook(env, owner);
  const terms = keywords(input);
  const rank = terms.length ? terms.map(() => "CASE WHEN LOWER(input||COALESCE(feedback,'')) LIKE ? THEN 1 ELSE 0 END").join("+") : "0";
  const earliest = /最早|第一次|第一篇/.test(input.messages.at(-1)?.content || "");
  const [counts, draftCount, reviews, drafts, mistakes] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS total,SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed FROM reviews WHERE user_id=?").bind(owner).first<{ total: number; completed: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM drafts WHERE user_id=?").bind(owner).first<{ n: number }>(),
    env.DB.prepare(`SELECT *,(${rank}) AS relevance FROM reviews WHERE user_id=? ORDER BY relevance DESC,created_at ${earliest ? "ASC" : "DESC"},id LIMIT 6`)
      .bind(...terms.map((t) => `%${t}%`), owner).all<Row>(),
    env.DB.prepare("SELECT * FROM drafts WHERE user_id=? ORDER BY updated_at DESC LIMIT 2").bind(owner).all<Row>(),
    listNotebookItems(env, owner),
  ]);
  const evidence: TeacherHistoryEvidence[] = [{
    kind: "history", title: "我的练习与薄弱点概览", url: null,
    note: `当前账号 · ${draftCount?.n || 0} 篇草稿 · ${counts?.completed || 0} 份已完成批改`,
    text: JSON.stringify({
      scope: "仅当前登录账号的已保存数据。按本轮问题检索了相关记录，不能声称逐篇读完全部历史；没有记录时应如实说明。错题次数由所有已完成批改归档，代表出现过该问题的不同批改数，不是官方扣分。草稿不是批改结论，未保存的编辑器内容未提供。",
      totalReviews: counts?.total || 0, completedReviews: counts?.completed || 0, totalDrafts: draftCount?.n || 0,
      selectedReviewCount: reviews.results.length, selectedDraftCount: drafts.results.length,
      activeMistakeCount: mistakes.filter((m) => m.status === "active").length,
      recurringMistakes: mistakes.filter((m) => m.status === "active").slice(0, 8).map((m) => ({
        title: m.title, wrong: m.wrong, right: m.right, pattern: m.pattern, reviewCount: m.occurrenceCount,
        explanation: m.explanation.slice(0, 700), sourceReviewIds: m.occurrences.slice(0, 4).map((o) => o.reviewId),
      })),
    }),
  }];
  let remaining = 28000 - evidence[0].text.length;
  for (const row of reviews.results) {
    const essay = JSON.parse(String(row.input)) as EssayInput;
    const question = JSON.parse(String(row.question)) as Question;
    const feedback = row.feedback ? JSON.parse(String(row.feedback)) as Feedback : null;
    const text = JSON.stringify({
      createdAt: row.created_at, status: row.status,
      question: { name: question.name, task: question.task, examType: question.examType, stem: question.stem.slice(0, 1800), sourceText: question.sourceText.slice(0, 2000), questionExcerpted: question.stem.length > 1800 || question.sourceText.length > 2000 },
      essay: essay.essay.slice(0, 4500), essayTruncated: essay.essay.length > 4500,
      feedback: feedback ? { summary: feedback.summary.slice(0, 1500), score: feedback.holisticScore, scoreScope: "历史AI非官方参考评价，不是正式考试得分", feedbackExcerpted: true,
        priorities: feedback.priorities.slice(0, 3).map((p) => ({ title: p.title.slice(0, 120), reason: p.reason.slice(0, 500), action: p.action.slice(0, 600) })),
        corrections: feedback.corrections.slice(0, 5).map((c) => ({ kind: c.kind, original: c.original.slice(0, 900), replacement: c.replacement.slice(0, 1000), reason: c.reason.slice(0, 650) })),
      } : null,
    });
    if (text.length > remaining) continue;
    remaining -= text.length;
    evidence.push({
      kind: "history", reviewId: String(row.id), url: null,
      title: `${String(row.created_at).slice(0, 10)} · ${essay.title || question.name}`,
      note: `当前账号的${levelLabel(question.examType)}${taskLabel(question.task)}批改 · ${row.status === "completed" ? "已完成" : row.status === "processing" ? "处理中" : "未完成"}`,
      text,
    });
  }
  for (const row of drafts.results) {
    const essay = JSON.parse(String(row.input)) as EssayInput;
    const text = JSON.stringify({ title: essay.title, updatedAt: row.updated_at, essay: essay.essay.slice(0, 3000), essayTruncated: essay.essay.length > 3000, customQuestion: essay.customQuestion, questionId: essay.questionId, warning: "这是草稿，没有据此产生正式批改结论。" });
    if (text.length > remaining) continue;
    remaining -= text.length;
    evidence.push({ kind: "history", draftId: String(row.id), title: `${String(row.updated_at).slice(0, 10)} · ${essay.title || "已保存草稿"}`, note: "当前账号的已保存草稿，内容可能仍在修改", url: null, text });
  }
  return evidence;
}
