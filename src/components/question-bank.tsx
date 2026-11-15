"use client";
import { useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  MagnifyingGlass,
  FileArrowUp,
  X,
} from "@phosphor-icons/react";
import { type Question, isSupplementaryQuestion, levelLabel, taskLabel } from "@/lib/types";
import { questionTitles } from "@/lib/question-titles";
import { QuestionStatsLine, useQuestionStats } from "./question-stats";
export default function QuestionBank({
  questions,
  onSelect,
  onCustom,
  initialLevel,
  initialTask,
  initialSupplementary = false,
  onCultureMaterials,
}: {
  questions: Question[];
  onSelect: (q: Question) => void;
  onCustom: () => void;
  initialLevel?: string;
  initialTask?: string;
  initialSupplementary?: boolean;
  onCultureMaterials?: () => void;
}) {
  const stats = useQuestionStats();
  const byQuestion = useMemo(() => new Map(stats.data?.stats.map(value => [value.questionId, value]) || []), [stats.data]);
  const [level, setLevel] = useState(initialLevel || "all");
  const [task, setTask] = useState(initialTask || "all");
  const [session, setSession] = useState("all");
  const [supplementary, setSupplementary] = useState(initialSupplementary);
  const [category, setCategory] = useState("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const sessions = useMemo(
    () => [...new Set(questions.filter(q => !isSupplementaryQuestion(q)).map((q) => q.session))].sort().reverse(),
    [questions],
  );
  const categories = useMemo(() => [...new Set(questions.filter(isSupplementaryQuestion).map(q => q.category))], [questions]);
  const filtered = useMemo(
    () =>
      questions
        .filter(
          (q) =>
            isSupplementaryQuestion(q) === supplementary &&
            (level === "all" || q.examType === level) &&
            (supplementary || task === "all" || q.task === task) &&
            (supplementary ? category === "all" || q.category === category : session === "all" || q.session === session) &&
            `${questionTitles[q.id] || ""} ${q.topic} ${q.stem} ${q.sourceText} ${q.name} ${q.category}`
              .toLowerCase()
              .includes(query.trim().toLowerCase()),
        )
        .sort(
          (a, b) =>
            b.session.localeCompare(a.session) ||
            a.set - b.set ||
            a.examType.localeCompare(b.examType) ||
            a.task.localeCompare(b.task),
        ),
    [questions, level, task, session, query, supplementary, category],
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / 12));
  const current = Math.min(page, pageCount - 1);
  const reset = () => {
    setLevel("all");
    setTask("all");
    setSession("all");
    setCategory("all");
    setQuery("");
    setPage(0);
  };
  return (
    <div className="bank-view">
      <div className="page-intro bank-intro">
        <h1>{supplementary ? "中国文化补充题库" : "真题题库"}</h1>
        
        <button className="button secondary" onClick={onCustom}>
          <FileArrowUp size={18} />
          上传自己的题目
        </button>
      </div>
      <div className="bank-corpus segment" role="group" aria-label="题库类型">
        {([[false, "历年真题"], [true, "中国文化补充题"]] as const).map(([value, label]) => <button key={String(value)} type="button" aria-pressed={supplementary === value} onClick={() => { setSupplementary(value); setSession("all"); setCategory("all"); setPage(0); }}>{label}</button>)}
      </div>
      {supplementary && <p className="bank-supplement-note">围绕《中国文化概况》的主题原创改编，分四级和六级练习。均为补充练习，不是真题或押题；提交批改后可查看参考译文。{onCultureMaterials && <button type="button" className="text-button" onClick={onCultureMaterials}>查看主题词汇<ArrowRight size={15} /></button>}</p>}
      <div className="bank-filters">
        <div className="search-field">
          <MagnifyingGlass size={19} />
          <input
            aria-label="搜索题目"
            placeholder="搜索英文话题、中文原文或考期"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
          />
          {query && (
            <button
              className="icon-button"
              aria-label="清空搜索"
              onClick={() => {
                setQuery("");
                setPage(0);
              }}
            >
              <X size={16} />
            </button>
          )}
        </div>
        <div className="filter-row">
          <div className="segment" role="group" aria-label="考试级别筛选">
            {[
              ["all", "全部级别"],
              ["CET4", "四级"],
              ["CET6", "六级"],
            ].map(([id, label]) => (
              <button
                key={id}
                aria-pressed={level === id}
                onClick={() => {
                  setLevel(id);
                  setPage(0);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          {!supplementary && <div className="segment" role="group" aria-label="练习任务筛选">
            {[
              ["all", "全部任务"],
              ["writing", "写作"],
              ["translation", "翻译"],
            ].map(([id, label]) => (
              <button
                key={id}
                aria-pressed={task === id}
                onClick={() => {
                  setTask(id);
                  setPage(0);
                }}
              >
                {label}
              </button>
            ))}
          </div>}
          <label className="session-filter">
            <span className="sr-only">{supplementary ? "文化主题筛选" : "考试日期筛选"}</span>
            <select
              aria-label={supplementary ? "文化主题筛选" : "考试日期筛选"}
              value={supplementary ? category : session}
              onChange={(e) => {
                if (supplementary) setCategory(e.target.value); else setSession(e.target.value);
                setPage(0);
              }}
            >
              <option value="all">{supplementary ? "全部文化主题" : "全部考期"}</option>
              {(supplementary ? categories : sessions).map((s) => (
                <option key={s} value={s}>
                  {supplementary ? s : `${s.replace("-", "年")}月`}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <div className="bank-result-line">
        <span className="small muted" role="status">
          {questions.length ? `找到 ${filtered.length} 道题目` : "正在载入题库"}{" "}
          · {supplementary ? "中国文化主题练习" : "考期从新到旧"}
        </span>
        <button className="text-button" onClick={reset}>
          重置筛选
        </button>
      </div>
      {stats.error && <p className="bank-stats-note" role="status">统计暂时未能{stats.data ? "刷新" : "载入"}。<button type="button" className="text-button" onClick={stats.retry}>重试</button></p>}
      {!questions.length ? (
        <div className="question-card-grid question-card-skeleton" aria-label="正在加载题库">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} />
          ))}
        </div>
      ) : !filtered.length ? (
        <div className="empty">
          <MagnifyingGlass size={32} />
          <h2>没有找到匹配题目</h2>
          <p>试试更短的关键词，或清除部分筛选。</p>
          <button className="button secondary" onClick={reset}>
            清除筛选
          </button>
        </div>
      ) : (
        <div className="question-card-grid">
          {filtered.slice(current * 12, current * 12 + 12).map((q) => (
            <button
              className="question-card"
              type="button"
              key={q.id}
              onClick={() => onSelect(q)}
            >
                <span className="question-card-tags">
                  <span className="tag subtle">{levelLabel(q.examType)}</span>
                  <span className="tag">{taskLabel(q.task)}</span>
                  {isSupplementaryQuestion(q) && <span className="tag subtle">原创改编</span>}
                  {q.needsVisual && (
                    <span className="tag subtle">图意待核验</span>
                  )}
                </span>
                <span className="question-card-title" lang="zh-CN">{isSupplementaryQuestion(q) ? q.topic : questionTitles[q.id] || q.category}</span>
                <QuestionStatsLine stat={byQuestion.get(q.id)} loaded={!!stats.data} error={stats.error} maxScore={15} />
                <span className="question-card-excerpt" lang={q.task === "translation" ? "zh-CN" : "en"}>
                  {q.sourceText || q.stem.replace(/^Directions:\s*/i, "")}
                </span>
                <span className="question-card-footer">
                  <span className="question-card-source">
                  {isSupplementaryQuestion(q) ? `补充练习 · 题号 ${q.id}` : `${q.session} · 第${q.set}套`}<br />
                  {q.category}
                  {q.wordLimit
                    ? ` · ${q.wordLimit.min}-${q.wordLimit.max} 词`
                    : ""}
                  </span>
                  <ArrowRight size={20} aria-hidden="true" />
                </span>
            </button>
          ))}
        </div>
      )}
      <div className="pagination">
        <button
          className="button secondary"
          disabled={current === 0}
          onClick={() => {
            setPage(current - 1);
            window.scrollTo({ top: 150, behavior: "instant" });
          }}
        >
          <ArrowLeft size={16} />
          上一页
        </button>
        <span className="small">
          {current + 1} / {pageCount}
        </span>
        <button
          className="button secondary"
          disabled={current >= pageCount - 1}
          onClick={() => {
            setPage(current + 1);
            window.scrollTo({ top: 150, behavior: "instant" });
          }}
        >
          下一页
          <ArrowRight size={16} />
        </button>
      </div>
    </div>
  );
}
