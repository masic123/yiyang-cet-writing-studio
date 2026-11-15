"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight, ArrowSquareOut, BookOpen, ChalkboardTeacher, PaperPlaneTilt, Plus, SlidersHorizontal, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import { api, Modal } from "./ui";
import type { User } from "@/lib/types";
import type { TeacherContext, TeacherReply, TeacherSource, TeacherTurn } from "@/lib/teacher-types";

type Message = TeacherTurn & { id: string; sources?: TeacherSource[] };
const sourceKind = { official: "官方依据", advice: "练习建议", sample: "官方样卷", question: "题库题目", scope: "资料范围", context: "当前题目", history: "我的练习记录" };

function Answer({ message, onReview, onHistory }: { message: Message; onReview: (id: string) => void; onHistory: () => void }) {
  function inline(text: string): ReactNode[] {
    return text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[\d+\])/g).map((part, i) => {
      const citation = part.match(/^\[(\d+)\]$/);
      const source = citation && message.sources?.find((s) => s.id === Number(citation[1]));
      if (source) return <a className="teacher-citation" key={i} href={`#teacher-source-${message.id}-${source.id}`} aria-label={`资料 ${source.id}：${source.title}`}>{part}</a>;
      if (part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
      if (part.startsWith("`") && part.endsWith("`")) return <code key={i}>{part.slice(1, -1)}</code>;
      return part;
    });
  }
  return <div className="teacher-answer">
    {message.content.split(/\n\s*\n/).map((block, i) => {
      const lines = block.split("\n");
      if (lines.every((line) => /^\s*[-*]\s+/.test(line))) return <ul key={i}>{lines.map((line, n) => <li key={n}>{inline(line.replace(/^\s*[-*]\s+/, ""))}</li>)}</ul>;
      if (lines.every((line) => /^\s*\d+[.)、]\s*/.test(line))) return <ol key={i}>{lines.map((line, n) => <li key={n}>{inline(line.replace(/^\s*\d+[.)、]\s*/, ""))}</li>)}</ol>;
      if (/^#{1,3}\s+/.test(block)) return <h3 key={i}>{inline(block.replace(/^#{1,3}\s+/, ""))}</h3>;
      return <p key={i}>{inline(block)}</p>;
    })}
    {!!message.sources?.length && <div className="teacher-sources" aria-label="本次回答的资料依据">
      <p><BookOpen size={15} />本次回答依据</p>
      {message.sources.map((source) => <div className="teacher-source" key={source.id} id={`teacher-source-${message.id}-${source.id}`}>
        <span className="teacher-source-index">[{source.id}]</span>
        <div>
          {source.reviewId ? <button className="text-button teacher-record-link" onClick={() => onReview(source.reviewId!)}>{source.title}<ArrowRight size={13} /></button> : source.draftId ? <button className="text-button teacher-record-link" onClick={onHistory}>{source.title}<ArrowRight size={13} /></button> : source.url && source.kind !== "question" && source.kind !== "context" ? <a href={source.url} target="_blank" rel="noreferrer">{source.title}<ArrowSquareOut size={13} /></a> : <strong>{source.title}</strong>}
          <small>{sourceKind[source.kind]} · {source.kind === "question" && !source.note.includes("原创改编") ? "按题目原文核对，图意不确定时请先确认" : source.kind === "context" ? source.note.replace(/ · 第三方整理/g, "") : source.note}</small>
        </div>
      </div>)}
    </div>}
  </div>;
}

function TeacherDataNotes() {
  return <>
    <p>开启历史记录后，会按问题将当前账号的相关草稿、批改和薄弱点提供给 DeepSeek；未保存的编辑器正文不会自动读取。回答中的引用可用于核对原记录。</p>
    <p>真题目前覆盖 2015 年 6 月至 2026 年 6 月，2013 年 12 月至 2014 年 12 月仍待补齐核验。20 篇样卷的分数来自官方大纲，19 篇英文转写仍有疑点，请以 PDF 原页为准。库外事实和未核实的图意无法据此确认。</p>
  </>;
}

export default function AITeacher({ user, configured, active, context, questionLabel, onLogin, onLibrary, onReview, onHistory }: {
  user: User | null;
  configured: boolean | null;
  active: boolean;
  context: TeacherContext;
  questionLabel: string;
  onLogin: () => void;
  onLibrary: () => void;
  onReview: (id: string) => void;
  onHistory: () => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [question, setQuestion] = useState("");
  const [attachQuestion, setAttachQuestion] = useState(false);
  const [includeHistory, setIncludeHistory] = useState(true);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const request = useRef<AbortController | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const busy = !!pending;
  useEffect(() => {
    if (!user) return;
    try { setIncludeHistory(localStorage.getItem(`cet:teacher-history:${user.id}`) !== "off"); } catch {}
  }, [user?.id]);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (!active || !log.current) return;
    const latestQuestion = Array.from(log.current.querySelectorAll<HTMLElement>(".teacher-message.user")).at(-1);
    log.current.scrollTop = pending ? log.current.scrollHeight : Math.max(0, (latestQuestion?.offsetTop || 0) - 16);
  }, [messages, pending, active]);

  async function send() {
    if (!user) { onLogin(); return; }
    const text = question.trim();
    if (!text || request.current) return;
    if (!configured) { setError("AI 老师尚未连接，请稍后再试。"); return; }
    const history: TeacherTurn[] = messages.slice(-12).map(({ role, content }) => ({ role, content }));
    while (history.length && history.reduce((n, turn) => n + turn.content.length, text.length) > 23000) history.splice(0, 2);
    const controller = new AbortController();
    request.current = controller;
    setPending(text);
    setQuestion("");
    setError("");
    try {
      const reply = await api<TeacherReply>("/api/teacher", {
        method: "POST", signal: controller.signal,
        body: JSON.stringify({ messages: [...history, { role: "user", content: text }], includeHistory, ...(attachQuestion ? { context } : {}) }),
      });
      if (controller.signal.aborted) return;
      setMessages((old) => [...old,
        { id: crypto.randomUUID(), role: "user", content: text },
        { id: crypto.randomUUID(), role: "assistant", content: reply.answer, sources: reply.sources },
      ]);
    } catch (cause) {
      if (!controller.signal.aborted) {
        setQuestion(text);
        setError((cause as Error).message);
      }
    } finally {
      if (!controller.signal.aborted) {
        request.current = null;
        setPending("");
        requestAnimationFrame(() => composer.current?.focus({ preventScroll: true }));
      }
    }
  }

  function contextOptions(className = "") {
    return <div className={`teacher-context-options ${className}`}>
      <label className="teacher-context"><input type="checkbox" checked={includeHistory} disabled={!user || busy} onChange={(e) => { setIncludeHistory(e.target.checked); if (user) try { localStorage.setItem(`cet:teacher-history:${user.id}`, e.target.checked ? "on" : "off"); } catch {} }} /><span>读取我的练习与批改<small>仅当前账号的已保存记录</small></span></label>
      <label className="teacher-context"><input type="checkbox" checked={attachQuestion} disabled={!user || busy} onChange={(e) => setAttachQuestion(e.target.checked)} /><span>结合当前题目<small title={questionLabel}>{questionLabel}</small></span></label>
    </div>;
  }

  return <section className="teacher-view" aria-labelledby="teacher-title">
    <div className="page-intro teacher-intro">
      <h1 id="teacher-title">AI 老师</h1>
      <button className="text-button" onClick={onLibrary}><BookOpen size={18} />查看资料<ArrowRight size={15} /></button>
    </div>
    <div className="teacher-room">
      <div className="teacher-room-heading">
        <span><ChalkboardTeacher size={22} />AI 老师</span>
        <div className="teacher-room-actions">
          <button type="button" className="text-button teacher-mobile-settings" aria-label="对话设置与资料说明" aria-haspopup="dialog" aria-expanded={active && settingsOpen} onClick={() => setSettingsOpen(true)}><SlidersHorizontal size={17} /><span>设置</span></button>
          <button type="button" className="text-button" disabled={busy || (!messages.length && !error)} onClick={() => { setMessages([]); setQuestion(""); setError(""); composer.current?.focus({ preventScroll: true }); }}><Plus size={16} />新对话</button>
        </div>
      </div>
      <div className={`teacher-log ${!messages.length && !pending ? "is-empty" : ""}`} ref={log} role="log" aria-label="与 AI 老师的对话" aria-live="polite" aria-relevant="additions">
        {messages.map((message) => <article className={`teacher-message ${message.role}`} key={message.id} aria-label={message.role === "user" ? "你的提问" : "AI 老师的回答"}>
          <span className="teacher-speaker">{message.role === "user" ? "你" : <><ChalkboardTeacher size={17} />AI 老师</>}</span>
          {message.role === "user" ? <p className="teacher-user-question">{message.content}</p> : <Answer message={message} onReview={onReview} onHistory={onHistory} />}
        </article>)}
        {pending && <>
          <article className="teacher-message user"><span className="teacher-speaker">你</span><p className="teacher-user-question">{pending}</p></article>
          <div className="teacher-thinking" role="status"><SpinnerGap size={18} className="spin" /><span>正在查阅资料，整理回答…</span></div>
        </>}
      </div>
      <form className="teacher-compose" aria-label="向 AI 老师提问" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        {contextOptions("teacher-inline-context")}
        {error && <p className="error-box teacher-error" role="alert"><WarningCircle size={18} />{error}</p>}
        {configured === false && !error && <p className="small muted">AI 老师暂时不可用，请稍后重试。</p>}
        <label className="sr-only" htmlFor="teacher-question">你的问题</label>
        <textarea id="teacher-question" ref={composer} rows={3} value={question} maxLength={3000} readOnly={!user} disabled={busy} placeholder={user ? "写下问题，或贴上一两句英文…" : "邮箱登录后，即可向 AI 老师提问。"} onChange={(e) => setQuestion(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} aria-describedby="teacher-compose-note" />
        <div className="teacher-compose-actions"><small id="teacher-compose-note">{user ? <>{question.length} / 3000<span className="teacher-send-shortcut"> · Ctrl + Enter 发送</span></> : "游客模式 · 只读"}</small>
          {user ? <button className="button primary" type="submit" disabled={busy || !question.trim() || !configured}>{busy ? <SpinnerGap size={17} className="spin" /> : <PaperPlaneTilt size={17} />}{busy ? "正在回答" : "发送问题"}</button> : <button className="button primary" type="button" onClick={onLogin}>邮箱登录后提问<ArrowRight size={17} /></button>}
        </div>
      </form>
    </div>
    <p className="teacher-footnote">刷新后本次对话会清空。</p>
    <details className="teacher-scope"><summary>数据与资料说明</summary><TeacherDataNotes /></details>
    <Modal open={active && settingsOpen} onOpenChange={setSettingsOpen} title="对话设置与资料" description="选择回答时参考的内容。">
      <div className="teacher-settings">
        {contextOptions()}
        <button type="button" className="button secondary" onClick={() => { setSettingsOpen(false); onLibrary(); }}><BookOpen size={18} />查看学习资料<ArrowRight size={16} /></button>
        <p className="teacher-settings-reset">刷新后本次对话会清空。</p>
        <details className="teacher-scope"><summary>数据与资料说明</summary><TeacherDataNotes /></details>
      </div>
    </Modal>
  </section>;
}
