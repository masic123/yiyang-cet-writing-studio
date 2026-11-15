"use client";
import { useEffect, useMemo, useState } from "react";
import { reviewProgress } from "@/lib/review-progress";
import TargetCoachingPanel from "./target-coaching";
import { targetCoachingText } from "@/lib/target-coaching-format";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle,
  DownloadSimple,
  Target,
  ArrowSquareOut,
} from "@phosphor-icons/react";
import { type Review, levelLabel, taskLabel } from "@/lib/types";
import { buildRevisions, revisionText } from "@/lib/revisions";
import { withTranslationSources } from "@/lib/translation-revisions";
import { methodSourceLabel } from "@/lib/methods";
import { hasOutline, outlineText } from "@/lib/outline";
import { officialSource } from "@/lib/resources";
import { cultureTranslationById } from "@/lib/culture-translation";
import { AnnotatedOriginal, SentenceRevisions } from "./sentence-revisions";
import ExpressionSuggestions from "./expression-suggestions";
export function downloadText(text: string, name: string) {
  const link = document.createElement("a");
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/plain;charset=utf-8" }),
  );
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const diagnosticLabels = {
  secure: "值得保留",
  developing: "还可改善",
  priority: "优先处理",
};
const alignmentLabels = {
  accurate: "原意准确",
  partial: "表达不完整",
  missing: "存在漏译",
  mistranslated: "需要纠正",
};
export default function Report({
  review,
  connectionNotice,
  onBack,
  onRewrite,
  onNotebook,
}: {
  review: Review;
  connectionNotice?: string;
  onBack: () => void;
  onRewrite: () => void;
  onNotebook?: () => void;
}) {
  const [tab, setTab] = useState<
    "sentences" | "feedback" | "alignment" | "rewrite" | "original" | "goal"
  >("sentences");
  const [activeSentence, setActiveSentence] = useState<string | null>(null);
  const [navigation, setNavigation] = useState(0);
  const f = review.feedback;
  const cultureReference = cultureTranslationById.get(review.question.id);
  const revisionUnavailable = f?.revisionAssessment?.status === "unverified" || !f?.improvedEssay.trim();
  const revisionUnavailableMessage = "完整修改稿暂未提供。原作答的评分与批改反馈已保留，你可以参考逐句修改继续练习。";
  const failureMessage = review.error && /^(?:评分复核未通过[：:]|错误核验未完成(?:[，,。]|$)|评分复核未完成(?:[，,。]|$))/.test(review.error)
    ? "本次评分复核未完成，草稿已保留，请稍后重试。"
    : review.error;
  const revisions = useMemo(
    () => {
      const document = buildRevisions(review.input.essay, f?.corrections || []);
      return review.question.task === "translation"
        ? withTranslationSources(document, review.input.essay, review.question.sourceText, {
            alignment: f?.alignment || [], scoringEvidence: f?.scoringEvidence,
          })
        : document;
    },
    [review.input.essay, review.question.task, review.question.sourceText, f?.corrections, f?.alignment, f?.scoringEvidence],
  );
  const jumpTo = (view: "sentences" | "original", id: string) => {
    setTab(view);
    setActiveSentence(id);
    setNavigation((n) => n + 1);
  };
  useEffect(() => {
    if (!activeSentence || (tab !== "sentences" && tab !== "original")) return;
    const frame = requestAnimationFrame(() => {
      const el = document.getElementById(
        `${tab === "original" ? "source" : "revision"}-${activeSentence}`,
      );
      el?.focus({ preventScroll: true });
      el?.scrollIntoView({
        block: "center",
        behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeSentence, tab, navigation]);
  function exportReport() {
    if (!f) return;
    const text = [
      `# ${levelLabel(review.question.examType)}${taskLabel(review.question.task)}批改报告`,
      `## ${review.question.task === "translation" ? "题干原文" : "本次题目"}\n${review.question.stem}\n\n${review.question.sourceText}`,
      `AI整体参考分：${f.holisticScore ?? "未评"} / 15\n参考档位：${f.bandRange || "仅语言反馈"}`,
      f.summary,
      `定档理由：${f.scoreReason}`,
      `## 优先改进\n${f.priorities.map((v) => `${v.title}\n${v.reason}\n${v.action}`).join("\n\n")}`,
      `## 教学诊断（不计分）\n${f.diagnostics.map((d) => `${d.area}：${diagnosticLabels[d.status]}\n依据：${d.evidence}\n建议：${d.advice}`).join("\n\n")}`,
      f.alignment.length ? `## 原意核对\n${f.alignment.map((a) => `${a.source}\n作答：${a.student || "未找到对应表达"}\n${alignmentLabels[a.status]}：${a.explanation}\n建议：${a.suggestion}`).join("\n\n")}` : "",
      `## 逐句修改\n${revisionText(revisions)}`,
      `## ${review.question.task === "translation" ? "我的译文" : "原文"}\n${review.input.essay}`,
      `## 修改稿\n${revisionUnavailable ? revisionUnavailableMessage : f.improvedEssay}`,
      cultureReference ? `## 补充题参考译文（原创改编，译法不唯一）\n${cultureReference.referenceTranslation}` : "",
      f.advancedSuggestions?.length ? `## 表达进阶（学习建议）\n${f.advancedSuggestions.map((s) => `原表达：${s.original}\n建议表达：${s.replacement}\n${s.explanation}\n例句：${s.example}`).join("\n\n")}` : "",
      targetCoachingText(f.targetCoaching),
      `## 下次练习\n${f.exercises.map((e) => `${e.title}\n${e.instruction}`).join("\n\n")}`,
      `依据：${officialSource.title} PDF第15-16页\n${officialSource.url}`,
      "本报告由AI生成，仅供学习参考。15分原始分不换算为官方报道分。",
    ].filter(Boolean).join("\n\n");
    downloadText(text, "四六级写译-批改报告.md");
  }
  return (
    <div className="report-view">
      <div className="report-toolbar">
        <button className="text-button" onClick={onBack}>
          <ArrowLeft size={18} />
          返回我的练习
        </button>
        <button
          className="button secondary"
          disabled={!f}
          onClick={exportReport}
        >
          <DownloadSimple size={17} />
          导出报告
        </button>
      </div>
      <div className="page-intro compact">
        <h1>批改报告</h1>
        <p>
          {review.input.title || review.question.name} ·{" "}
          {new Date(review.createdAt).toLocaleString("zh-CN")}
        </p>
      </div>
      {review.status === "processing" ? (
        <div className="empty" role="status" aria-live="polite">
          <div className="loading-line" />
          <h2>{reviewProgress(review).title}</h2>
          <p>{reviewProgress(review).description}</p>
          {connectionNotice && <p>{connectionNotice}</p>}
        </div>
      ) : !f ? (
        <div className="error-box" role="alert">
          {failureMessage || "未能生成有效报告。"}
          <button className="text-button" onClick={onRewrite}>
            回到正文重试
            <ArrowRight size={16} />
          </button>
        </div>
      ) : (
        <>
          <section className="score-overview">
            <div className="score-hero">
              <span>AI 整体参考分</span>
              <div className="score-total">
                <strong>{f.holisticScore ?? "未评"}</strong>
                {f.holisticScore !== null && <span>/ 15</span>}
              </div>
              <span className="tag">
                {f.bandRange ? `${f.bandRange} 分档` : "仅语言与结构反馈"}
              </span>
              <span className="small">
                {levelLabel(review.question.examType)} ·{" "}
                {taskLabel(review.question.task)}
              </span>
            </div>
            <div className="score-summary">
              <h2>
                {review.question.task === "translation"
                  ? "原意传达得怎么样？"
                  : "这次表达，完成了什么？"}
              </h2>
              <p>{f.summary}</p>
              <div className="score-reason">
                <b>定档依据</b>
                <p>{f.scoreReason}</p>
              </div>
            </div>
          </section>
          {onNotebook && <div className="report-notebook-link"><p>把真实错误留在错题本，换一个场景再练一次。</p><button className="text-button" onClick={onNotebook}>查看错题本<ArrowRight size={16} /></button></div>}
          <details className="report-question">
            <summary>
              查看本次题目
              {review.question.task === "translation" ? "与中文原文" : ""}
            </summary>
            <p lang="en">{review.question.stem}</p>
            {review.question.sourceText && <p>{review.question.sourceText}</p>}
          </details>
          {cultureReference && <details className="report-question" key={`reference-${review.question.id}`}>
            <summary>查看中国文化补充题参考译文</summary>
            <p className="small muted">本题为原创改编练习，参考译文供练后对照；准确、自然的其他译法同样可以接受。</p>
            <p lang="en">{cultureReference.referenceTranslation}</p>
          </details>}
          {revisionUnavailable && <p className="small muted" role="status">{revisionUnavailableMessage}</p>}
          <div
            className="report-tabs segment"
            role="group"
            aria-label="报告内容"
          >
            {(
              [
                ["sentences", "逐句修改"],
                ...(review.question.task === "translation"
                  ? [["alignment", "原意核对"]]
                  : []),
                ["feedback", "批改建议"],
                ["goal", "目标提升"],
                ["rewrite", "完整修改稿"],
                ["original", "原文标注"],
              ] as [typeof tab, string][]
            ).map(([id, label]) => (
              <button
                key={id}
                aria-pressed={tab === id}
                onClick={() => {
                  setTab(id);
                  setActiveSentence(null);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          {tab === "goal" ? (
            <TargetCoachingPanel coaching={f.targetCoaching} target={review.input.targetScore} scale="cet" />
          ) : tab === "sentences" ? (
            <SentenceRevisions
              document={revisions}
              activeId={activeSentence}
              onLocate={(id) => jumpTo("original", id)}
              onDownload={() =>
                downloadText(revisionText(revisions), "四六级写译-逐句对照.txt")
              }
            />
          ) : tab === "original" ? (
            <AnnotatedOriginal
              document={revisions}
              essay={review.input.essay}
              activeId={activeSentence}
              onOpen={(id) => jumpTo("sentences", id)}
              onDownload={() =>
                downloadText(review.input.essay, "四六级写译-原文.txt")
              }
            />
          ) : tab === "alignment" ? (
            <section className="report-section">
              <h2>逐意群核对原意</h2>
              <p className="muted">
                重点看信息、逻辑和限定是否保留。以下对照用于诊断，不是逐点扣分表。
              </p>
              <div className="alignment-list">
                {f.alignment.map((a, i) => (
                  <article key={i} className={`alignment-row ${a.status}`}>
                    <div className="alignment-source">
                      <span className="small muted">中文原文</span>
                      <p>{a.source}</p>
                    </div>
                    <div className="alignment-student">
                      <div className="between">
                        <span className="small muted">我的译文</span>
                        <span
                          className={`tag ${a.status === "accurate" ? "" : "subtle"}`}
                        >
                          {alignmentLabels[a.status]}
                        </span>
                      </div>
                      <p lang="en">{a.student || "未找到对应表达"}</p>
                      <p className="alignment-explanation">{a.explanation}</p>
                      {a.suggestion && (
                        <p className="action-line">{a.suggestion}</p>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ) : tab === "rewrite" ? (
            <section className="report-section">
              <div className="between">
                <h2>
                  {revisionUnavailable
                    ? "完整修改稿暂未提供"
                    : review.question.task === "translation"
                    ? "忠实原文，改善英文表达"
                    : "保留你的观点，改善表达"}
                </h2>
                {!revisionUnavailable && <button
                  className="text-button"
                  onClick={() =>
                    downloadText(f.improvedEssay, "四六级写译-修改稿.txt")
                  }
                >
                  <DownloadSimple size={17} />
                  下载
                </button>}
              </div>
              {revisionUnavailable ? <p role="status">{revisionUnavailableMessage}</p> : <>
                <div className="essay-prose" lang="en">
                  {f.improvedEssay}
                </div>
                <p className="small muted">
                  基于本篇作答的修改示例，不承诺满分。修改稿复核结果见本页总评；可选表达练习不计为错误。
                </p>
              </>}
            </section>
          ) : (
            <>
              <section className="report-section">
                <h2>
                  <Target size={21} />
                  优先改好这几处
                </h2>
                <div className="priority-list">
                  {f.priorities.map((p, i) => (
                    <article key={i}>
                      <span className="ordinal">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <div>
                        <h3>{p.title}</h3>
                        <p>{p.reason}</p>
                        <p className="action-line">{p.action}</p>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
              <section className="report-section">
                <h2>教学诊断</h2>
                <p className="muted small">
                  这些项目帮助定位问题，不是官方分项分，也不参与加权计算。
                </p>
                <div className="diagnostic-grid">
                  {f.diagnostics.map((d, i) => (
                    <article key={i}>
                      <div className="between">
                        <h3>{d.area}</h3>
                        <span className="tag subtle">
                          {diagnosticLabels[d.status]}
                        </span>
                      </div>
                      <blockquote>{d.evidence}</blockquote>
                      <p>{d.advice}</p>
                    </article>
                  ))}
                </div>
              </section>
              {f.strengths.length > 0 && (
                <section className="report-section strengths">
                  <h2>
                    <CheckCircle size={21} />
                    值得保留的表达
                  </h2>
                  {f.strengths.map((s, i) => (
                    <p key={i}>{s}</p>
                  ))}
                </section>
              )}
              {f.methodChecks.length > 0 && (
                <section className="report-section">
                  <h2>结合方法再检查</h2>
                  {f.methodChecks.map((check, i) => {
                    const rule = review.references.find(
                      (r) => r.id === check.ruleId,
                    );
                    return (
                      <article className="method-check" key={i}>
                        <div className="between">
                          <h3>{rule?.title || check.ruleId}</h3>
                          <span className="tag subtle">
                            {
                              {
                                met: "已做到",
                                partial: "还可加强",
                                missing: "需要补充",
                                not_applicable: "本题不适用",
                              }[check.status]
                            }
                          </span>
                        </div>
                        <p>{check.evidence}</p>
                        <p>{check.advice}</p>
                        {rule && (
                          <a
                            className="small muted source-link"
                            href={rule.source.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {methodSourceLabel(rule)}
                            <ArrowSquareOut size={13} />
                          </a>
                        )}
                      </article>
                    );
                  })}
                </section>
              )}
              {f.paragraphs.length > 0 && (
                <section className="report-section">
                  <h2>逐段梳理</h2>
                  {f.paragraphs.map((p, i) => (
                    <article className="paragraph-note" key={i}>
                      <span className="ordinal">
                        {String(p.index).padStart(2, "0")}
                      </span>
                      <div>
                        <h3>{p.role}</h3>
                        <p>{p.feedback}</p>
                        <p className="action-line">{p.suggestion}</p>
                      </div>
                    </article>
                  ))}
                </section>
              )}
              {f.exercises.length > 0 && (
                <section className="report-section practice">
                  <h2>下一次练习</h2>
                  {f.exercises.map((e, i) => (
                    <div key={i}>
                      <h3>{e.title}</h3>
                      <p>{e.instruction}</p>
                    </div>
                  ))}
                </section>
              )}
            </>
          )}
          <ExpressionSuggestions suggestions={f.advancedSuggestions} />
          <div className="report-bottom">
            <p>带着这次的反馈，再试一次。</p>
            <button className="button primary" onClick={onRewrite}>
              重新练习这道题
              <ArrowRight size={18} />
            </button>
          </div>
          {hasOutline(review.input.outline) && (
            <details className="report-outline">
              <summary>查看这次的写前笔记</summary>
              <p className="small muted">笔记没有计入正文评分。</p>
              <pre>{outlineText(review.input.outline!, review.question)}</pre>
            </details>
          )}
          <p className="source-note">
            依据公开大纲进行的 AI 整体评价，尚未用独立人工评分集验证准确率。原始
            15 分不换算为官方报道分。
            <a
              href={`${officialSource.url}#page=15`}
              target="_blank"
              rel="noreferrer"
            >
              查看官方评分方法
            </a>
          </p>
        </>
      )}
    </div>
  );
}
