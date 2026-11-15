"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, ArrowCounterClockwise, BookOpen, CheckCircle, Eye, SpinnerGap } from "@phosphor-icons/react";
import { practiceSentences, normalizeWord, sentenceTokens, sentenceGaps, sentenceHintSignature, wordMatches } from "@/lib/sentence-practice";
import type { ExamLevel, User } from "@/lib/types";
import { api } from "./ui";

type Progress = { completed: string[]; points: number; todayPoints: number };
const empty: Progress = { completed: [], points: 0, todayPoints: 0 };
export default function SentencePractice({ user, onLogin, onAward }: { user: User | null; onLogin: () => void; onAward: () => void }) {
  const [level, setLevel] = useState<ExamLevel>("CET4");
  const [topic, setTopic] = useState("");
  const [corpus, setCorpus] = useState<"past" | "culture">("past");
  const [selectedId, setSelectedId] = useState(practiceSentences[0].id);
  const [mode, setMode] = useState<"learn" | "recall">("learn");
  const [answers, setAnswers] = useState<string[]>([]);
  const [hintSeed, setHintSeed] = useState("");
  const [progress, setProgress] = useState<{owner: string; value: Progress} | null>(null);
  const [progressError, setProgressError] = useState("");
  const [awardState, setAwardState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [message, setMessage] = useState("");
  const owner = user?.id || "guest";
  const latestOwner = useRef(owner); latestOwner.current = owner;
  const previousOwner = useRef(owner);
  const inFlight = useRef<string | null>(null);
  const progressRequest = useRef(0);
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const selected = practiceSentences.find(row => row.id === selectedId)!;
  const tokens = useMemo(() => sentenceTokens(selected.english, hintSeed || undefined), [selected.english, hintSeed]);
  const gaps = useMemo(() => sentenceGaps(selected.english, hintSeed || undefined), [selected.english, hintSeed]);
  const current = progress?.owner === owner ? progress.value : empty;
  const completed = new Set(current.completed);
  const filtered = practiceSentences.filter(row => row.examType === level && row.corpus === corpus && (!topic || row.questionId === Number(topic)));
  const topics = [...new Map(practiceSentences.filter(row => row.examType === level && row.corpus === corpus).map(row => [row.questionId, row])).values()];
  const correctWords = gaps.filter((word, index) => wordMatches(answers[index] || "", word)).length;
  const allCorrect = correctWords === gaps.length && answers.length === gaps.length;
  const loadProgress = useCallback(async () => {
    if (!user) { setProgress(null); setProgressError(""); return; }
    const requestedOwner = user.id;
    const request = ++progressRequest.current;
    try {
      const data = await api<Progress>("/api/sentence-practice");
      if (latestOwner.current === requestedOwner && progressRequest.current === request) { setProgress({ owner: requestedOwner, value: data }); setProgressError(""); }
    } catch { if (latestOwner.current === requestedOwner && progressRequest.current === request) setProgressError("学习进度暂未载入，请重试。"); }
  }, [user?.id]);
  useEffect(() => { void loadProgress(); }, [loadProgress]);
  useEffect(() => {
    const guestLogin = previousOwner.current === "guest" && owner !== "guest";
    previousOwner.current = owner;
    inFlight.current = null; setAwardState("idle"); setMessage("");
    if (!guestLogin) { setMode("learn"); setAnswers([]); }
  }, [owner]);
  useEffect(() => {
    inFlight.current = null; setMode("learn"); setAnswers([]); setAwardState("idle"); setMessage("");
  }, [selectedId]);
  useEffect(() => {
    if (!filtered.some(row => row.id === selectedId) && filtered[0]) setSelectedId(filtered[0].id);
  }, [level, topic, selectedId, corpus]);
  async function savePoints() {
    if (!user || !allCorrect || inFlight.current) return;
    const requestedOwner = user.id, requestedSentence = selected.id;
    const requestKey = requestedOwner + ":" + requestedSentence + ":" + crypto.randomUUID();
    progressRequest.current++;
    inFlight.current = requestKey; setAwardState("saving"); setMessage("");
    try {
      const data = await api<Progress & {passed:boolean;awarded:boolean}>("/api/sentence-practice/complete", { method: "POST", body: JSON.stringify({ sentenceId: requestedSentence, hintSeed: hintSeed || undefined, answers }) });
      if (latestOwner.current !== requestedOwner || inFlight.current !== requestKey) return;
      if (!data.passed) throw new Error("题目已更新，请重新开始默写。");
      setProgress({ owner: requestedOwner, value: data }); setAwardState("saved");
      setMessage(data.awarded ? "默写通过，+1 分，已计入每日榜和总榜。" : "默写通过。这句话已得过 1 分，本次不重复计分。");
      onAward();
    } catch (error) {
      if (latestOwner.current === requestedOwner && inFlight.current === requestKey) { setAwardState("error"); setMessage((error as Error).message); inFlight.current = null; }
    }
  }
  useEffect(() => {
    if (mode === "recall" && allCorrect && user && awardState === "idle") void savePoints();
  }, [mode, allCorrect, owner, selectedId, awardState]);
  function start() {
    const storageKey = "cet:sentence-hints:" + selected.id;
    let previous = hintSeed || undefined;
    try { previous = localStorage.getItem(storageKey) || previous; } catch {}
    const previousHints = sentenceHintSignature(selected.english, previous);
    let nextSeed = crypto.randomUUID().replaceAll("-", "");
    for (let attempt = 0; attempt < 40 && sentenceHintSignature(selected.english, nextSeed) === previousHints; attempt++) nextSeed = attempt.toString(16).padStart(32, "0");
    try { localStorage.setItem(storageKey, nextSeed); } catch {}
    setHintSeed(nextSeed);
    inFlight.current = null; setAnswers(Array(sentenceGaps(selected.english,nextSeed).length).fill("")); setAwardState("idle"); setMessage(""); setMode("recall");
    requestAnimationFrame(() => inputs.current[0]?.focus());
  }
  function next() {
    const index = filtered.findIndex(row => row.id === selectedId);
    const following = [...filtered.slice(index + 1), ...filtered.slice(0, index + 1)];
    setSelectedId((following.find(row => !completed.has(row.id)) || following[0] || selected).id);
  }
  function changeLevel(value: ExamLevel) { setLevel(value); setTopic(""); }
  return <div className="sentence-practice">
    <header className="sentence-heading"><div><h1>逐句精翻</h1><p>先背诵，再默写。每句首次通过得 1 分。</p></div><div className="sentence-progress" aria-label="精翻进度"><strong>{current.completed.length}<span> / {practiceSentences.length} 句</span></strong><small>今日 +{current.todayPoints} 分</small></div></header>
    {progressError && <p className="error-box" role="alert">{progressError}<button type="button" className="text-button" onClick={() => void loadProgress()}>重试</button></p>}
    <div className="sentence-filters"><div role="group" aria-label="精翻题库">{([["past", "真题句子"], ["culture", "中国文化补充"]] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={corpus === value} onClick={() => { setCorpus(value); setTopic(""); }}>{label}</button>)}</div><div role="group" aria-label="精翻级别">{([['CET4','四级'],['CET6','六级']] as const).map(([value,label]) => <button type="button" key={value} aria-pressed={level === value} onClick={() => changeLevel(value)}>{label}</button>)}</div><label>主题<select value={topic} onChange={event => setTopic(event.target.value)}><option value="">全部主题</option>{topics.map(row => <option key={row.questionId} value={row.questionId}>{row.topic}{row.corpus === "past" ? ` · 第${row.set}套` : ""}</option>)}</select></label></div>
    <div className="sentence-layout">
      <section className="sentence-card" aria-label="当前精翻句子" key={selected.id}>
        <div className="sentence-meta"><span>{selected.examType === "CET4" ? "四级" : "六级"}翻译 · {selected.corpus === "culture" ? "中国文化补充 · 原创改编" : `${selected.session} · 第${selected.set}套`}</span>{completed.has(selected.id) && <span className="sentence-done"><CheckCircle size={16} />已获 1 分</span>}</div>
        <p className="sentence-chinese">{selected.chinese.replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g,"$1")}</p>
        {mode === "learn" ? <>
          <div className="sentence-reference"><h2><BookOpen size={17} />参考译文</h2><p lang="en">{selected.english}</p></div>
          <div className="sentence-actions"><button type="button" className="button primary" onClick={start}>开始默写<ArrowRight size={18} /></button><button type="button" className="button secondary" onClick={next}>下一句</button></div>
        </> : <>
          <div className="sentence-exam-heading"><h2>补全英文译文</h2><span>{correctWords} / {gaps.length} 空</span></div>
          <p className="sentence-instructions" id="sentence-input-help">按参考译文默写；字母下方实线表示正确，波浪线表示有误。大小写不影响通过。</p>
          <div className="sentence-gaps" lang="en" role="group" aria-label="英文句子填空" aria-describedby="sentence-input-help">{tokens.map((token,index) => token.gap === null ? <span key={index} className={token.word ? "sentence-hint" : "sentence-punctuation"}>{token.text}</span> : <label className="sentence-word" key={index} style={{width:`${Math.min(28,Math.max(4,token.text.length+1,(answers[token.gap] || "").length+1))}ch`}}>
            <span className="sentence-letters" aria-hidden="true">{Array.from({length:Math.max(token.text.length,(answers[token.gap] || "").length)},(_,letter) => { const char=(answers[token.gap!] || "")[letter]; return <span key={letter} className={!char ? "letter-empty" : normalizeWord(char) === normalizeWord(token.text[letter] || "") ? "letter-correct" : "letter-incorrect"}>{char || "_"}</span>; })}</span>
            <input ref={element => { inputs.current[token.gap!] = element; }} aria-label={`第 ${token.gap+1} 个空，${token.text.length} 个字符`} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} value={answers[token.gap] || ""} maxLength={60} readOnly={awardState === "saving" || awardState === "saved"} onChange={event => { const value=event.target.value.replace(/\s/g,""); setAnswers(previous => { const next=[...previous]; next[token.gap!]=value; return next; }); }} onKeyDown={event => { if ((event.key === " " || event.key === "Enter") && wordMatches(answers[token.gap!] || "", token.text)) { event.preventDefault(); inputs.current[token.gap!+1]?.focus(); } }} />
          </label>)}</div>
          <div className={`sentence-result ${awardState === "error" ? "has-error" : ""}`} role="status">{awardState === "saving" ? <><SpinnerGap className="spin" size={18} />正在保存积分…</> : message || (allCorrect && !user ? "默写正确，登录后可保存积分。" : `${correctWords} 个空已填写正确`)}</div>
          <div className="sentence-actions">{awardState === "saved" ? <button type="button" className="button primary" onClick={next}>下一句<ArrowRight size={18} /></button> : allCorrect && !user ? <button type="button" className="button primary" onClick={onLogin}>登录并保存积分</button> : awardState === "error" ? <button type="button" className="button primary" onClick={() => void savePoints()}>重试保存积分</button> : null}<button type="button" className="button secondary" disabled={awardState === "saving"} onClick={start}><ArrowCounterClockwise size={17} />重新默写</button><button type="button" className="text-button" disabled={awardState === "saving"} onClick={() => setMode("learn")}><Eye size={17} />返回背诵</button></div>
        </>}
        <footer className="sentence-source"><span>参考译文用于背诵，翻译可有多种表达。</span></footer>
      </section>
      <aside className="sentence-index" aria-label="选择精翻句子"><h2>{level === "CET4" ? "四级" : "六级"}{corpus === "culture" ? "补充句子" : "真题句子"}<span>{filtered.filter(row => completed.has(row.id)).length} / {filtered.length}</span></h2><div>{filtered.map((row,index) => <button type="button" key={row.id} aria-current={row.id === selectedId ? "true" : undefined} aria-label={`第 ${index+1} 句：${row.chinese}${completed.has(row.id) ? "，已通过" : ""}`} title={row.chinese} onClick={() => setSelectedId(row.id)}><span>{completed.has(row.id) ? <CheckCircle size={18} weight="fill" /> : String(index+1).padStart(2,"0")}</span><p>{row.chinese}</p></button>)}</div></aside>
    </div>
  </div>;
}
