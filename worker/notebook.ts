import { HttpError } from "../src/lib/http";
import { extractNotebookMistakes } from "../src/lib/notebook";
import type { Review, ExamLevel, Task } from "../src/lib/types";
import type {
  MistakeDetail, MistakeEvidence, MistakeStatus, NotebookItem, NotebookExercise,
  PracticeContent, PracticeFeedback, PracticeAttempt, PracticeTarget, NotebookData,
} from "../src/lib/notebook-types";
import { digest } from "./auth";
import type { Env } from "./types";

type Row = Record<string, unknown>;
const parse = <T>(value: unknown): T => JSON.parse(String(value));
async function itemId(owner: string, signature: string) {
  const bytes = (await digest(`notebook-v1:${owner}:${signature}`)).slice(0, 32).split("");
  bytes[12] = "5";
  bytes[16] = ((parseInt(bytes[16], 16) & 3) | 8).toString(16);
  const s = bytes.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

export async function archiveReviewMistakes(env: Env, owner: string, review: Review) {
  if (review.status !== "completed" || !review.feedback) return;
  if (await env.DB.prepare("SELECT review_id FROM notebook_sources WHERE user_id=? AND review_id=?").bind(owner, review.id).first()) return;
  const mistakes = extractNotebookMistakes(review);
  const statements = [];
  for (let index = 0; index < mistakes.length; index++) {
    const { signature, detail, evidence } = mistakes[index];
    const id = await itemId(owner, signature);
    statements.push(env.DB.prepare(`INSERT INTO notebook_items(id,user_id,signature,detail,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
      detail=CASE WHEN excluded.updated_at>=notebook_items.updated_at THEN excluded.detail ELSE notebook_items.detail END,
      status=CASE WHEN notebook_items.status='mastered' AND excluded.updated_at>notebook_items.updated_at THEN 'active' ELSE notebook_items.status END,
      updated_at=MAX(notebook_items.updated_at,excluded.updated_at)`)
      .bind(id, owner, signature, JSON.stringify(detail), review.createdAt));
    statements.push(env.DB.prepare("INSERT OR IGNORE INTO notebook_occurrences(id,user_id,item_id,review_id,evidence,created_at) VALUES(?,?,?,?,?,?)")
      .bind(`${review.id}:${index}`, owner, id, review.id, JSON.stringify(evidence), review.createdAt));
  }
  statements.push(env.DB.prepare("INSERT OR IGNORE INTO notebook_sources(user_id,review_id) VALUES(?,?)").bind(owner, review.id));
  await env.DB.batch(statements);
}

/** Incremental, retry-safe backfill, including reports beyond the history UI's 100 rows. */
export async function syncNotebook(env: Env, owner: string) {
  while (true) {
    const rows = (await env.DB.prepare(`SELECT r.* FROM reviews r WHERE r.user_id=? AND r.status='completed'
      AND NOT EXISTS(SELECT 1 FROM notebook_sources s WHERE s.user_id=r.user_id AND s.review_id=r.id)
      ORDER BY r.created_at LIMIT 50`).bind(owner).all<Row>()).results;
    if (!rows.length) break;
    for (const r of rows) {
      await archiveReviewMistakes(env, owner, {
        id: String(r.id), status: "completed", feedback: r.feedback ? parse(r.feedback) : null,
        createdAt: String(r.created_at), input: parse(r.input), question: parse(r.question),
      } as Review);
      // Malformed historical records must not cause an infinite backfill loop.
      if (!r.feedback) await env.DB.prepare("INSERT OR IGNORE INTO notebook_sources(user_id,review_id) VALUES(?,?)").bind(owner, r.id).run();
    }
  }
}

export async function listNotebookItems(env: Env, owner: string): Promise<NotebookItem[]> {
  const rows = (await env.DB.prepare(`SELECT i.*,COUNT(DISTINCT o.review_id) AS occurrences FROM notebook_items i
    JOIN notebook_occurrences o ON o.item_id=i.id AND o.user_id=i.user_id
    WHERE i.user_id=? GROUP BY i.id ORDER BY occurrences DESC,i.updated_at DESC,i.id`).bind(owner).all<Row>()).results;
  const occurrences = (await env.DB.prepare("SELECT item_id,evidence FROM notebook_occurrences WHERE user_id=? ORDER BY created_at DESC,id")
    .bind(owner).all<Row>()).results;
  const byItem = new Map<string, MistakeEvidence[]>();
  for (const row of occurrences) {
    const id = String(row.item_id);
    const list = byItem.get(id) || [];
    list.push(parse<MistakeEvidence>(row.evidence));
    byItem.set(id, list);
  }
  return rows.map((r) => ({
    ...parse<MistakeDetail>(r.detail), id: String(r.id), status: r.status as MistakeStatus,
    occurrenceCount: Number(r.occurrences), updatedAt: String(r.updated_at), occurrences: byItem.get(String(r.id)) || [],
  }));
}

export async function updateNotebookItem(env: Env, owner: string, id: string, status: MistakeStatus) {
  const row = await env.DB.prepare("UPDATE notebook_items SET status=?,updated_at=? WHERE id=? AND user_id=? RETURNING id")
    .bind(status, new Date().toISOString(), id, owner).first();
  if (!row) throw new HttpError(404, "没有找到这条错题。");
}

export async function expireNotebookJobs(env: Env, owner: string) {
  const before = new Date(Date.now() - 4 * 60000).toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE notebook_exercises SET status='failed',error=? WHERE user_id=? AND status='processing' AND created_at<?")
      .bind("生成中断或超时，请重新生成。", owner, before),
    env.DB.prepare("UPDATE notebook_attempts SET status='failed',error=? WHERE user_id=? AND status='processing' AND created_at<?")
      .bind("检查中断或超时，作答已保存，请重试。", owner, before),
  ]);
}
const attemptFrom = (r: Row): PracticeAttempt => ({
  id: String(r.id), exerciseId: String(r.exercise_id), answer: String(r.answer), status: r.status as PracticeAttempt["status"],
  feedback: r.feedback ? parse(r.feedback) : null, error: r.error ? String(r.error) : null, createdAt: String(r.created_at),
});
function exerciseFrom(r: Row, attempts: PracticeAttempt[]): NotebookExercise {
  const content = r.content ? parse<PracticeContent>(r.content) : null;
  const revealed = !!r.revealed || attempts.some((a) => a.status === "completed");
  return {
    id: String(r.id), task: r.task as Task, examType: r.exam_type as ExamLevel,
    status: r.status as NotebookExercise["status"], targets: parse(r.targets),
    content: content ? { title: content.title, instruction: content.instruction, prompt: content.prompt } : null,
    solution: revealed && content ? { referenceAnswer: content.referenceAnswer, coverage: content.coverage } : null,
    revealed, error: r.error ? String(r.error) : null, createdAt: String(r.created_at), attempts,
  };
}
export async function getNotebookExerciseRow(env: Env, owner: string, id: string) {
  const row = await env.DB.prepare("SELECT * FROM notebook_exercises WHERE id=? AND user_id=?").bind(id, owner).first<Row>();
  if (!row) throw new HttpError(404, "没有找到这道专项练习。");
  return row;
}
export async function getNotebookExercise(env: Env, owner: string, id: string) {
  const row = await getNotebookExerciseRow(env, owner, id);
  const attempts = (await env.DB.prepare("SELECT * FROM notebook_attempts WHERE user_id=? AND exercise_id=? ORDER BY created_at DESC,id DESC")
    .bind(owner, id).all<Row>()).results.map(attemptFrom);
  return exerciseFrom(row, attempts);
}
export async function getNotebookData(env: Env, owner: string): Promise<NotebookData> {
  await syncNotebook(env, owner);
  await expireNotebookJobs(env, owner);
  const [items, exerciseRows, attemptRows, count] = await Promise.all([
    listNotebookItems(env, owner),
    env.DB.prepare("SELECT * FROM notebook_exercises WHERE user_id=? ORDER BY created_at DESC,id DESC").bind(owner).all<Row>(),
    env.DB.prepare("SELECT * FROM notebook_attempts WHERE user_id=? ORDER BY created_at DESC,id DESC").bind(owner).all<Row>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM notebook_sources WHERE user_id=?").bind(owner).first<{ n: number }>(),
  ]);
  const byExercise = new Map<string, PracticeAttempt[]>();
  for (const row of attemptRows.results) {
    const a = attemptFrom(row), list = byExercise.get(a.exerciseId) || [];
    list.push(a); byExercise.set(a.exerciseId, list);
  }
  return { items, exercises: exerciseRows.results.map((r) => exerciseFrom(r, byExercise.get(String(r.id)) || [])), reviewedCount: count?.n || 0 };
}

export async function beginNotebookExercise(env: Env, owner: string, data: { itemIds: string[]; requestKey: string; task: Task; examType: ExamLevel }, model: string) {
  await expireNotebookJobs(env, owner);
  const existing = await env.DB.prepare("SELECT id FROM notebook_exercises WHERE user_id=? AND request_key=?").bind(owner, data.requestKey).first<{ id: string }>();
  if (existing) return { exercise: await getNotebookExercise(env, owner, existing.id), created: false };
  await syncNotebook(env, owner);
  const targets: PracticeTarget[] = [];
  for (const id of data.itemIds) {
    const row = await env.DB.prepare("SELECT detail,status FROM notebook_items WHERE id=? AND user_id=?").bind(id, owner).first<Row>();
    if (!row || row.status === "ignored") throw new HttpError(404, "所选错题不存在或已忽略，请刷新错题本。");
    targets.push({ id, ...parse<MistakeDetail>(row.detail) });
  }
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare("INSERT INTO notebook_exercises(id,user_id,request_key,task,exam_type,status,targets,model,created_at) VALUES(?,?,?,?,?,'processing',?,?,?)")
      .bind(id, owner, data.requestKey, data.task, data.examType, JSON.stringify(targets), model, new Date().toISOString()).run();
  } catch {
    const duplicate = await env.DB.prepare("SELECT id FROM notebook_exercises WHERE user_id=? AND request_key=?").bind(owner, data.requestKey).first<{ id: string }>();
    if (duplicate) return { exercise: await getNotebookExercise(env, owner, duplicate.id), created: false };
    throw new HttpError(409, "已有一道练习正在生成，请稍候。");
  }
  return { exercise: await getNotebookExercise(env, owner, id), created: true };
}
export async function finishNotebookExercise(env: Env, owner: string, id: string, content: PracticeContent | null, error?: string) {
  await env.DB.prepare("UPDATE notebook_exercises SET status=?,content=?,error=? WHERE id=? AND user_id=? AND status='processing'")
    .bind(content ? "completed" : "failed", content ? JSON.stringify(content) : null, error || null, id, owner).run();
  return getNotebookExercise(env, owner, id);
}
export async function revealNotebookExercise(env: Env, owner: string, id: string) {
  await getNotebookExerciseRow(env, owner, id);
  await env.DB.prepare("UPDATE notebook_exercises SET revealed=1 WHERE id=? AND user_id=?").bind(id, owner).run();
  return getNotebookExercise(env, owner, id);
}
export async function beginNotebookAttempt(env: Env, owner: string, exerciseId: string, requestKey: string, answer: string) {
  await expireNotebookJobs(env, owner);
  const row = await getNotebookExerciseRow(env, owner, exerciseId);
  if (row.status !== "completed" || !row.content) throw new HttpError(409, "题目尚未生成，请稍候。");
  const existing = await env.DB.prepare("SELECT * FROM notebook_attempts WHERE user_id=? AND request_key=?").bind(owner, requestKey).first<Row>();
  if (existing) {
    if (existing.exercise_id !== exerciseId) throw new HttpError(409, "该提交编号属于另一道练习，请重新提交。");
    return { attempt: attemptFrom(existing), created: false, row };
  }
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare("INSERT INTO notebook_attempts(id,user_id,exercise_id,request_key,answer,status,created_at) VALUES(?,?,?,?,?,'processing',?)")
      .bind(id, owner, exerciseId, requestKey, answer, new Date().toISOString()).run();
  } catch {
    const duplicate = await env.DB.prepare("SELECT * FROM notebook_attempts WHERE user_id=? AND request_key=?").bind(owner, requestKey).first<Row>();
    if (duplicate) {
      if (duplicate.exercise_id !== exerciseId) throw new HttpError(409, "该提交编号属于另一道练习，请重新提交。");
      return { attempt: attemptFrom(duplicate), created: false, row };
    }
    throw new HttpError(409, "已有一份作答正在检查，请稍候。");
  }
  const saved = await env.DB.prepare("SELECT * FROM notebook_attempts WHERE id=? AND user_id=?").bind(id, owner).first<Row>();
  return { attempt: attemptFrom(saved!), created: true, row };
}
export async function finishNotebookAttempt(env: Env, owner: string, id: string, feedback: PracticeFeedback | null, error?: string) {
  await env.DB.prepare("UPDATE notebook_attempts SET status=?,feedback=?,error=? WHERE id=? AND user_id=? AND status='processing'")
    .bind(feedback ? "completed" : "failed", feedback ? JSON.stringify(feedback) : null, error || null, id, owner).run();
  // Learning status is a user decision. An AI check never silently marks a point mastered.
}
