"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, ArrowCounterClockwise, BookBookmark, Check, CheckCircle, Eye, MagnifyingGlass, Sparkle, SpinnerGap, UploadSimple, UserCircle, WarningCircle } from "@phosphor-icons/react";
import { api } from "./ui";
import HandwrittenAnswerDialog from "./handwritten-answer";
import { levelLabel, taskLabel, wordCount, type User, type Task, type ExamLevel } from "@/lib/types";
import { mistakeLabels, type MistakeStatus, type NotebookData, type NotebookExercise, type NotebookItem } from "@/lib/notebook-types";

const dateLabel = (date: string) => new Date(date).toLocaleString("zh-CN", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const resultLabels = { secure: "本次用对了", retry: "还需练习", missing: "本次未用到" };
type Props = { user: User | null; active: boolean; revision: string; configured: boolean | null; importerAvailable: boolean; onLogin: () => void; onReview: (id: string) => void; onWriter: () => void };

export default function MistakeNotebook({ user, active, revision, configured, importerAvailable, onLogin, onReview, onWriter }: Props) {
  const [data, setData] = useState<NotebookData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"mistakes" | "practice">("mistakes");
  const [filter, setFilter] = useState<MistakeStatus>("active");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [task, setTask] = useState<Task>("translation");
  const [level, setLevel] = useState<ExamLevel>("CET4");
  const [currentId, setCurrentId] = useState("");
  const [busy, setBusy] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const initialized = useRef(false);
  const mounted = useRef(true);
  const answerCache = useRef<Record<string, string>>({});
  const [answer, setAnswer] = useState("");
  const currentIdRef = useRef(currentId);
  currentIdRef.current = currentId;
  const controller = useRef<AbortController | null>(null);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); }; }, []);
  function apply(next: NotebookData) {
    setData(next);
    if (!initialized.current) {
      setSelected(next.items.filter((i) => i.status === "active").slice(0, 3).map((i) => i.id));
      initialized.current = true;
    }
    if (!currentIdRef.current && next.exercises.length) setCurrentId(next.exercises[0].id);
  }
  async function reload() {
    const next = await api<NotebookData>("/api/notebook");
    if (mounted.current) apply(next);
  }
  useEffect(() => {
    if (!active || !user) return;
    let live = true;
    setLoading(true);
    setError("");
    api<NotebookData>("/api/notebook").then((next) => { if (live) apply(next); }).catch((e) => { if (live) setError(e.message); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [active, user?.id, revision]);
  const pendingJobs = !!data?.exercises.some((e) => e.status === "processing" || e.attempts.some((a) => a.status === "processing"));
  useEffect(() => {
    if (!active || !user || !pendingJobs || busy) return;
    const timer = setInterval(() => { void reload().catch(() => {}); }, 4000);
    return () => clearInterval(timer);
  }, [active, user?.id, pendingJobs, busy]);

  const exercise = data?.exercises.find((e) => e.id === currentId);
  useEffect(() => {
    if (!exercise) { setAnswer(""); return; }
    let saved: string | undefined = answerCache.current[exercise.id];
    if (saved === undefined && user) {
      try { saved = localStorage.getItem(`cet:notebook:${user.id}:${exercise.id}`) ?? undefined; } catch {}
    }
    setAnswer(saved ?? exercise.attempts[0]?.answer ?? "");
  }, [exercise?.id, user?.id]);
  function changeAnswer(value: string) {
    setAnswer(value);
    if (!exercise || !user) return;
    answerCache.current[exercise.id] = value;
    try { localStorage.setItem(`cet:notebook:${user.id}:${exercise.id}`, value); } catch {}
  }
  function mergeExercise(next: NotebookExercise) {
    setData((old) => old ? { ...old, exercises: [next, ...old.exercises.filter((e) => e.id !== next.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) } : old);
    setCurrentId(next.id);
  }
  async function generate() {
    if (!user) { onLogin(); return; }
    if (busy || uploadBusy || !selected.length) return;
    setBusy("generate"); setError("");
    const request = new AbortController(); controller.current = request;
    try {
      const result = await api<{ exercise: NotebookExercise }>("/api/notebook/exercises", { method: "POST", signal: request.signal, body: JSON.stringify({ itemIds: selected, requestKey: crypto.randomUUID(), task, examType: level }) });
      if (!mounted.current) return;
      mergeExercise(result.exercise); setTab("practice");
    } catch (e) {
      if (mounted.current) { setError((e as Error).message); await reload().catch(() => {}); }
    } finally { if (mounted.current) setBusy(""); controller.current = null; }
  }
  async function status(item: NotebookItem, next: MistakeStatus) {
    if (busy) return;
    setBusy(item.id); setError("");
    try {
      await api("/api/notebook/items", { method: "PATCH", body: JSON.stringify({ id: item.id, status: next }) });
      if (!mounted.current) return;
      setData((old) => old ? { ...old, items: old.items.map((i) => i.id === item.id ? { ...i, status: next } : i) } : old);
      if (next !== "active") setSelected((old) => old.filter((id) => id !== item.id));
    } catch (e) { if (mounted.current) setError((e as Error).message); }
    finally { if (mounted.current) setBusy(""); }
  }
  async function checkAnswer() {
    if (!exercise || busy || uploadBusy || !answer.trim()) return;
    setBusy("check"); setError("");
    const request = new AbortController(); controller.current = request;
    try {
      const result = await api<{ exercise: NotebookExercise }>("/api/notebook/attempts", { method: "POST", signal: request.signal, body: JSON.stringify({ exerciseId: exercise.id, requestKey: crypto.randomUUID(), answer }) });
      if (mounted.current) mergeExercise(result.exercise);
    } catch (e) { if (mounted.current) { setError((e as Error).message); await reload().catch(() => {}); } }
    finally { if (mounted.current) setBusy(""); controller.current = null; }
  }
  async function reveal() {
    if (!exercise || busy) return;
    setBusy("reveal"); setError("");
    try {
      const result = await api<{ exercise: NotebookExercise }>("/api/notebook/reveal", { method: "POST", body: JSON.stringify({ id: exercise.id }) });
      if (mounted.current) mergeExercise(result.exercise);
    } catch (e) { if (mounted.current) setError((e as Error).message); }
    finally { if (mounted.current) setBusy(""); }
  }
  const visible = data?.items.filter((i) => i.status === filter && `${i.title} ${i.pattern} ${i.wrong} ${i.right}`.toLowerCase().includes(search.toLowerCase())) || [];
  const activeCount = data?.items.filter((i) => i.status === "active").length || 0;
  const recurringCount = data?.items.filter((i) => i.status === "active" && i.occurrenceCount > 1).length || 0;
  const selectedItems = data?.items.filter((i) => selected.includes(i.id)) || [];

  return <section className="notebook-view" hidden={!active} aria-labelledby="notebook-title">
    <div className="page-intro"><h1 id="notebook-title">错题本</h1></div>
    {!user ? <div className="empty"><UserCircle size={36} weight="light" /><h2>登录后建立你的错题本</h2><p>历史批改、薄弱表达和专项练习仅当前账号可见。</p><button className="button primary" onClick={onLogin}>邮箱登录<ArrowRight size={17} /></button></div> : <>
      <div className="notebook-summary"><BookBookmark size={25} weight="light" /><p>已整理 <strong>{data?.reviewedCount ?? 0}</strong> 份批改，待复习 <strong>{activeCount}</strong> 项，其中 <strong>{recurringCount}</strong> 项在多次练习中出现。</p><button className="text-button" disabled={loading || !!busy} onClick={() => { setLoading(true); setError(""); void reload().catch((e) => setError(e.message)).finally(() => setLoading(false)); }}><ArrowCounterClockwise size={16} />刷新</button></div>
      <div className="notebook-tabs segment" role="group" aria-label="错题本内容"><button aria-pressed={tab === "mistakes"} onClick={() => setTab("mistakes")}>薄弱表达</button><button aria-pressed={tab === "practice"} onClick={() => setTab("practice")}>专项练习{data?.exercises.length ? ` · ${data.exercises.length}` : ""}</button></div>
      {error && <p className="error-box notebook-error" role="alert"><WarningCircle size={18} />{error}</p>}
      {loading && !data ? <div className="empty" role="status"><SpinnerGap size={26} className="spin" /><p>正在整理历史批改…</p></div> : data && tab === "mistakes" ? <div className="notebook-layout">
        <div className="notebook-entries">
          <div className="notebook-filters"><div className="segment" role="group" aria-label="错题状态">{(["active", "mastered", "ignored"] as const).map((s) => <button key={s} onClick={() => setFilter(s)} aria-pressed={filter === s}>{s === "active" ? "待复习" : s === "mastered" ? "已掌握" : "已忽略"}</button>)}</div><label className="notebook-search"><MagnifyingGlass size={17} /><span className="sr-only">搜索薄弱表达</span><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索表达或规则" /></label></div>
          {!visible.length ? <div className="empty small-empty"><BookBookmark size={32} weight="light" /><h2>{data.items.length ? "这里暂时没有匹配的错题" : "第一份错题，来自真实的修改"}</h2><p>{data.items.length ? "试试其他状态或关键词。" : "提交写作或翻译批改后，真实错误会自动归档；可选的表达润色不会计入。"}</p>{!data.items.length && <button className="text-button" onClick={onWriter}>去写一篇<ArrowRight size={16} /></button>}</div> : <div className="notebook-item-list">{visible.map((item) => <article className="notebook-item" key={item.id}>
            <div className="notebook-item-heading"><label><input type="checkbox" checked={selected.includes(item.id)} disabled={!!busy || item.status === "ignored" || (!selected.includes(item.id) && selected.length >= 5)} onChange={(e) => setSelected((old) => e.target.checked ? [...old, item.id] : old.filter((id) => id !== item.id))} aria-label={`选择薄弱点：${item.title}`} /><span className="tag subtle">{mistakeLabels[item.kind]}</span></label><span className={item.occurrenceCount > 1 ? "notebook-repeat" : "muted small"}>{item.occurrenceCount > 1 ? `在 ${item.occurrenceCount} 次批改中出现` : "出现 1 次"}</span></div>
            <h2>{item.title}</h2><div className="notebook-expression"><div><small>曾经这样写</small><p lang="en">{item.wrong}</p></div><ArrowRight size={17} /><div><small>记住这个用法</small><p lang="en">{item.right}</p></div></div><p className="notebook-explanation">{item.explanation}</p>
            <details className="notebook-evidence"><summary>查看原句与批改来源 · {item.occurrenceCount} 次</summary>{item.occurrences.map((occ) => <div key={`${occ.reviewId}:${occ.original}`} className="notebook-occurrence"><p className="small muted">{dateLabel(occ.createdAt)} · {levelLabel(occ.examType)}{taskLabel(occ.task)}</p>{occ.source && <p><span>中文原意</span>{occ.source}</p>}<p lang="en"><span>原句</span>{occ.original}</p><p lang="en"><span>修改</span>{occ.replacement}</p><button className="text-button" onClick={() => onReview(occ.reviewId)}>{occ.question}<ArrowRight size={14} /></button></div>)}</details>
            <div className="notebook-item-actions">{item.status !== "active" ? <button className="text-button" disabled={!!busy} onClick={() => void status(item, "active")}><ArrowCounterClockwise size={15} />放回待复习</button> : <><button className="text-button" disabled={!!busy} onClick={() => void status(item, "mastered")}><CheckCircle size={16} />标记已掌握</button><button className="text-button muted" disabled={!!busy} onClick={() => void status(item, "ignored")}>这不是错误，忽略</button></>}</div>
          </article>)}</div>}
          <p className="notebook-note">同一份批改中的同类问题只记一次。AI 也可能误判，可忽略或恢复；已掌握的问题在新的批改中再次出错时，会回到待复习。</p>
        </div>
        <aside className="notebook-generator" aria-labelledby="practice-generator-title"><Sparkle size={27} weight="light" /><h2 id="practice-generator-title">把薄弱点放进一道题</h2><p>选 1 至 5 项，AI 会把它们融入同一个情境。</p><div className="notebook-selected" aria-live="polite">{selectedItems.length ? selectedItems.map((i) => <span key={i.id}><Check size={14} />{i.title}</span>) : <span className="muted">先勾选左侧的薄弱点</span>}</div><label>练习类型<select value={task} disabled={!!busy} onChange={(e) => setTask(e.target.value as Task)}><option value="translation">段落翻译</option><option value="writing">情境写作</option></select></label><label>练习难度<select value={level} disabled={!!busy} onChange={(e) => setLevel(e.target.value as ExamLevel)}><option value="CET4">四级</option><option value="CET6">六级</option></select></label><button className="button primary" disabled={!!busy || !selected.length || !configured || pendingJobs} onClick={() => void generate()}>{busy === "generate" ? <SpinnerGap size={17} className="spin" /> : <Sparkle size={17} />}{busy === "generate" ? "正在组合题目" : `生成专项练习${selected.length ? ` · ${selected.length} 项` : ""}`}</button><small>{configured === false ? "DeepSeek 暂未连接，请稍后再试。" : pendingJobs ? "已有练习正在处理，可在“专项练习”中查看。" : "原创练习与作答会保存到账号，供你反复回练。"}</small></aside>
      </div> : data && <div className="notebook-practice-layout"><aside className="notebook-practice-history"><h2>练习记录</h2>{!data.exercises.length ? <p className="muted">选择薄弱表达，生成第一道练习。</p> : data.exercises.map((e) => <button className={e.id === currentId ? "active" : ""} key={e.id} disabled={uploadBusy} onClick={() => { setUploadOpen(false); setCurrentId(e.id); }}><b>{e.content?.title || (e.status === "processing" ? "正在生成题目…" : "本次生成未完成")}</b><small>{dateLabel(e.createdAt)}</small><span>{levelLabel(e.examType)}{taskLabel(e.task)} · {e.targets.length} 项{e.attempts.length ? ` · 已练 ${e.attempts.filter((a) => a.status === "completed").length} 次` : ""}</span></button>)}</aside>
        <div className="notebook-practice-main">{!exercise ? <div className="empty"><Sparkle size={32} weight="light" /><h2>让旧错误，换个场景再练一次</h2><button className="button secondary" onClick={() => setTab("mistakes")}>选择薄弱表达<ArrowRight size={16} /></button></div> : exercise.status !== "completed" ? <div className="empty" role="status">{exercise.status === "processing" ? <SpinnerGap size={29} className="spin" /> : <WarningCircle size={29} />}<h2>{exercise.status === "processing" ? "正在把薄弱点组合成一道题" : "本次题目未生成"}</h2><p>{exercise.error || "稍后会自动刷新，练习会保存在当前账号。"}</p>{exercise.status === "failed" && <button className="button secondary" onClick={() => { setSelected(exercise.targets.map((t) => t.id)); setTask(exercise.task); setLevel(exercise.examType); setTab("mistakes"); }}>重新选择并生成<ArrowRight size={16} /></button>}</div> : <>
          <div className="notebook-practice-question"><div className="notebook-question-meta"><span className="tag subtle">{levelLabel(exercise.examType)} · {taskLabel(exercise.task)}专项</span><span className="small muted">AI 原创练习</span></div><h2>{exercise.content!.title}</h2><p>{exercise.content!.instruction}</p><div className="notebook-prompt">{exercise.content!.prompt}</div><details className="notebook-targets"><summary>本题练习的 {exercise.targets.length} 个薄弱点</summary>{exercise.targets.map((t) => <p key={t.id}>{t.title}</p>)}</details></div>
          <div className="notebook-answer"><div className="notebook-answer-heading"><label htmlFor="notebook-answer">你的作答</label><button className="text-button" disabled={!!busy || exercise.attempts.some((a) => a.status === "processing")} onClick={() => setUploadOpen(true)}><UploadSimple size={16} />{uploadBusy ? "正在识别手写答案" : "上传手写答案"}</button></div><textarea id="notebook-answer" rows={10} maxLength={12000} value={answer} disabled={busy === "check" || uploadBusy || exercise.attempts.some((a) => a.status === "processing")} onChange={(e) => changeAnswer(e.target.value)} placeholder="在这里用英文完成这道练习…" lang="en" /><div className="notebook-answer-actions"><small className="muted">{wordCount(answer)} 词 · 提交后保存到账号</small><button className="button primary" disabled={!!busy || uploadBusy || !configured || answer.trim().length < 5 || exercise.attempts.some((a) => a.status === "processing")} onClick={() => void checkAnswer()}>{busy === "check" ? <SpinnerGap size={17} className="spin" /> : <CheckCircle size={17} />}{busy === "check" ? "正在逐项检查" : "提交并检查薄弱点"}</button></div></div>
          {exercise.attempts.map((attempt, i) => <details className="notebook-attempt" key={attempt.id} open={i === 0}><summary>{dateLabel(attempt.createdAt)} · {attempt.status === "completed" ? "练习反馈" : attempt.status === "processing" ? "正在检查" : "检查未完成"}</summary>{attempt.feedback ? <><p>{attempt.feedback.summary}</p><div className="notebook-results">{attempt.feedback.results.map((r) => <article key={r.itemId}><span className={`tag ${r.status === "secure" ? "" : "subtle"}`}>{resultLabels[r.status]}</span><h3>{exercise.targets.find((t) => t.id === r.itemId)?.title}</h3>{r.quote && <blockquote lang="en">{r.quote}</blockquote>}{r.correction && <p lang="en" className="notebook-result-correction">{r.correction}</p>}<p>{r.explanation}</p></article>)}</div><details><summary>查看本次作答与修改稿</summary><h3>本次作答</h3><p className="notebook-saved-answer" lang="en">{attempt.answer}</p><h3>修改稿</h3><p className="notebook-saved-answer" lang="en">{attempt.feedback.revisedAnswer}</p></details></> : <p role="status">{attempt.error || "作答已保存，正在检查各项薄弱表达…"}</p>}</details>)}
          <div className="notebook-solution">{exercise.solution ? <details><summary>参考作答与薄弱点解析</summary><p lang="en" className="notebook-saved-answer">{exercise.solution.referenceAnswer}</p>{exercise.solution.coverage.map((c) => <p key={c.itemId}><strong lang="en">{c.expression}</strong><br />{c.explanation}</p>)}</details> : <button className="text-button" disabled={!!busy} onClick={() => void reveal()}><Eye size={17} />提前查看参考答案</button>}<p className="notebook-note">接受准确自然的其他表达。反馈仅检查本次练习，不换算成四六级考试分数；是否掌握由你在错题本中确认。</p></div>
        </>}</div></div>}
    </>}
    {user && exercise && <HandwrittenAnswerDialog key={exercise.id} open={uploadOpen} onOpenChange={setUploadOpen} loggedIn={true} importerAvailable={importerAvailable} onLogin={onLogin} currentEssay={answer} onBusyChange={setUploadBusy} onApply={(text) => { if (text.length > 12000) throw new Error("专项练习答案最多 12000 字符，请精简识别文字后再导入。"); changeAnswer(text); }} />}
  </section>;
}
