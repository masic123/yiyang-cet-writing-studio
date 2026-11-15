"use client";
import { useEffect, useState } from "react";
import {
  ArrowRight,
  ArrowSquareOut,
  BookOpen,
  SealCheck,
  WarningCircle,
} from "@phosphor-icons/react";
import {
  type ExamLevel,
  type MethodRule,
  type OfficialSamples,
  type Task,
  levelLabel,
  taskLabel,
} from "@/lib/types";
import { methodSourceLabel } from "@/lib/methods";
import { officialSource, scopeNote } from "@/lib/resources";
import { api } from "./ui";
const bands = [
  {
    anchor: 14,
    range: "13-15",
    writing: "切题，思想清楚，通顺连贯，基本没有语言错误，允许个别小错。",
    translation: "准确传达原意，行文流畅，用词贴切，允许个别小错。",
  },
  {
    anchor: 11,
    range: "10-12",
    writing: "切题，思想清楚，文字连贯，有少量语言错误。",
    translation: "基本传达原意，文字通顺连贯，没有重大语言错误。",
  },
  {
    anchor: 8,
    range: "7-9",
    writing: "基本切题，部分思想表达不够清楚，勉强连贯，错误较多且有严重错误。",
    translation: "勉强传达原意，用词欠准确，错误较多且有严重错误。",
  },
  {
    anchor: 5,
    range: "4-6",
    writing: "基本切题，思想表达不清楚，连贯性差，有较多严重语言错误。",
    translation: "仅传达小部分原意，用词不准确，严重语言错误较多。",
  },
  {
    anchor: 2,
    range: "1-3",
    writing: "条理不清，思路紊乱，语言支离破碎，多数句子有错且多数为严重错误。",
    translation: "译文支离破碎，除个别词句外，绝大部分没有传达原意。",
  },
];
export default function LearningLibrary({
  methods,
  onWrite,
}: {
  methods: MethodRule[];
  onWrite: () => void;
}) {
  const [tab, setTab] = useState("methods");
  const [task, setTask] = useState<Task>("writing");
  const [level, setLevel] = useState<ExamLevel>("CET4");
  const [samples, setSamples] = useState<OfficialSamples | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (tab !== "samples" || samples) return;
    let active = true;
    api<OfficialSamples>("/api/samples")
      .then((s) => {
        if (active) setSamples(s);
      })
      .catch(() => {
        if (active)
          setError("评分样卷暂时没有载入成功，可直接打开官方大纲 PDF。");
      });
    return () => {
      active = false;
    };
  }, [tab, samples]);
  const prompt = samples?.prompts.find(
    (p) => p.exam_level === level && p.task_type === task,
  );
  return (
    <div className="methods-view">
      <div className="page-intro">
        <h1>评分与方法</h1>
        
      </div>
      <div className="learning-intro">
        <SealCheck size={31} weight="light" />
        <div>
          <h2>整体 15 分，先定档再解释。</h2>
          <p>
            写作与翻译都采用总体印象评分。内容、语言和逻辑用于解释表现，不设自创权重，也不把单篇分数换算成成绩单分。
          </p>
          <a
            className="text-button"
            href={`${officialSource.url}#page=15`}
            target="_blank"
            rel="noreferrer"
          >
            阅读官方评分方法
            <ArrowSquareOut size={15} />
          </a>
        </div>
      </div>
      <div
        className="learning-tabs segment"
        role="group"
        aria-label="学习资料内容"
      >
        {[
          ["methods", "提分方法"],
          ["bands", "官方分档"],
          ["samples", "官方评分样卷"],
          ["sources", "资料来源"],
        ].map(([id, label]) => (
          <button key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab !== "sources" && (
        <div className="library-filters">
          <div className="segment" role="group" aria-label="资料任务筛选">
            {(["writing", "translation"] as Task[]).map((t) => (
              <button
                key={t}
                aria-pressed={task === t}
                onClick={() => setTask(t)}
              >
                {taskLabel(t)}
              </button>
            ))}
          </div>
          {tab === "samples" && (
            <div className="segment" role="group" aria-label="样卷级别筛选">
              {(["CET4", "CET6"] as ExamLevel[]).map((v) => (
                <button
                  key={v}
                  aria-pressed={level === v}
                  onClick={() => setLevel(v)}
                >
                  {levelLabel(v)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {tab === "methods" ? (
        <>
          <div className="method-library">
            {methods
              .filter((m) => m.task === task || m.task === "all")
              .map((m, i) => (
                <article key={m.id}>
                  <span className="method-number">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <div>
                    <span className="tag subtle">
                      {m.source.kind === "official_summary"
                        ? "官方要求摘要"
                        : "练习建议"}
                    </span>
                    <h2>{m.title}</h2>
                    <p className="method-summary">{m.summary}</p>
                    <p>{m.detail}</p>
                    <a
                      href={m.source.url}
                      className="small muted method-source source-link"
                      target="_blank"
                      rel="noreferrer"
                    >
                      {methodSourceLabel(m)}
                      <ArrowSquareOut size={13} />
                    </a>
                  </div>
                </article>
              ))}
          </div>
          <button className="button primary" onClick={onWrite}>
            带着方法练一题
            <ArrowRight size={17} />
          </button>
        </>
      ) : tab === "bands" ? (
        <section className="band-library">
          <h2>{taskLabel(task)}的五个分档</h2>
          <p className="muted">
            以下是官方描述摘要。四、六级需要结合各自能力要求及对应样卷理解，同一篇作答不能直接跨级换分。
          </p>
          <div className="band-list">
            {bands.map((b) => (
              <article className="band-row" key={b.anchor}>
                <div>
                  <strong>{b.range}</strong>
                  <span>代表分 {b.anchor}</span>
                </div>
                <p>{b[task]}</p>
                <button
                  className="text-button"
                  onClick={() => setTab("samples")}
                >
                  对照样卷
                  <ArrowRight size={15} />
                </button>
              </article>
            ))}
          </div>
          <a
            className="text-button"
            href={`${officialSource.url}#page=${task === "writing" ? 15 : 16}`}
            target="_blank"
            rel="noreferrer"
          >
            查看完整官方描述
            <ArrowSquareOut size={15} />
          </a>
        </section>
      ) : tab === "samples" ? (
        <section className="samples-library">
          <div className="sample-evidence-note">
            <BookOpen size={23} />
            <div>
              <h2>20 篇官方公开带分样卷</h2>
              <p>
                四种任务各 5 篇，每类仅一道题。分数来自官方大纲，英文转写经过
                MinerU / CodeBuddy 整理，19 篇仍有转写疑点。请优先核对 PDF
                原页，不能把转写文本当作无误的训练集。
              </p>
            </div>
          </div>
          {error ? (
            <p className="error-box" role="alert">
              {error}
            </p>
          ) : !samples ? (
            <div className="question-skeleton" aria-label="正在载入评分样卷">
              <div />
              <div />
            </div>
          ) : (
            prompt && (
              <>
                <details className="sample-prompt">
                  <summary>
                    {levelLabel(level)}
                    {taskLabel(task)} · 评分样卷题目
                  </summary>
                  <p lang="en">{prompt.prompt_text}</p>
                  {prompt.chinese_source && <p>{prompt.chinese_source}</p>}
                  <a
                    className="text-button"
                    href={`${officialSource.url}#page=${prompt.pdf_pages[0]}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    查看原题与图片
                    <ArrowSquareOut size={14} />
                  </a>
                </details>
                <div className="sample-list">
                  {samples.samples
                    .filter((s) => s.prompt_id === prompt.id)
                    .map((s) => (
                      <details key={s.id} className="sample-item">
                        <summary>
                          <span className="sample-score">
                            {s.score}
                            <small>/ 15</small>
                          </span>
                          <span>
                            <b>官方标分 {s.score} 分</b>
                            <small>
                              PDF 第 {s.pdf_pages.join("、")} 页 ·{" "}
                              {s.transcription_uncertainties?.length
                                ? "转写有待核对"
                                : "转写未标注具体疑点"}
                            </small>
                          </span>
                          <span className="sample-expand">展开作答</span>
                        </summary>
                        <div className="sample-body">
                          <a
                            className="text-button"
                            href={`${officialSource.url}#page=${s.pdf_pages[0]}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            打开原始评分页
                            <ArrowSquareOut size={14} />
                          </a>
                          <p className="small muted">
                            以下保留原作答中的错误；识别疑点不等于考生原错。
                          </p>
                          <pre lang="en">{s.text}</pre>
                          {!!s.transcription_uncertainties?.length && (
                            <div className="sample-uncertainties">
                              <h3>
                                <WarningCircle size={17} />
                                转写疑点
                              </h3>
                              {s.transcription_uncertainties.map((u, i) => (
                                <p key={i}>{u}</p>
                              ))}
                            </div>
                          )}
                        </div>
                      </details>
                    ))}
                </div>
              </>
            )
          )}
          <p className="source-note">
            官方公开示例不等于历年正式考试全部阅卷数据。当前没有大规模考场原始评分库，也没有用这些样卷证明
            AI 评分准确率。
          </p>
        </section>
      ) : (
        <section className="source-library">
          <h2>每一种资料，都有自己的边界。</h2>
          <article>
            <span className="tag">官方依据</span>
            <h3>2016 年修订版考试大纲</h3>
            <p>
              能力要求见 PDF 第 8-9 页，评分办法见第 15-16 页，带分样卷见第
              202-211 页。页面使用的是摘要，完整描述以官方原文为准。
            </p>
            <a
              className="text-button"
              href={officialSource.landing}
              target="_blank"
              rel="noreferrer"
            >
              考试院大纲入口
              <ArrowSquareOut size={14} />
            </a>
            <a
              className="text-button"
              href={officialSource.scores}
              target="_blank"
              rel="noreferrer"
            >
              官方分数解释
              <ArrowSquareOut size={14} />
            </a>
          </article>
          <article>
            <span className="tag subtle">第三方真题整理</span>
            <h3>304 道写作、翻译记录</h3>
            <p>{scopeNote}</p>
            <p>
              来自懒笔记公开题面，分别为四级、六级各 152
              道。每条保留考期、套卷、任务和出处。套卷序号以整理站为准，不把机构答案标成官方答案。
            </p>
            <a
              className="text-button"
              href="https://english-exam.lazynote.cn/"
              target="_blank"
              rel="noreferrer"
            >
              打开题目来源站
              <ArrowSquareOut size={14} />
            </a>
          </article>
          <article>
            <span className="tag subtle">AI 学习反馈</span>
            <h3>有证据的建议，仍需自己判断</h3>
            <p>
              模型依据公开分档要求解释本篇表现，修改示例不是官方答案。官网报道分把写作与翻译合并并作常模转换，不能从单篇
              15 分直接乘常数还原。
            </p>
          </article>
        </section>
      )}
    </div>
  );
}
