import { useId } from "react";
import type { TargetCoaching } from "@/lib/target-coaching-types";
import { coachingScoreLabel } from "@/lib/target-coaching-format";

export default function TargetCoachingPanel({ coaching, target, scale }: { coaching?: TargetCoaching; target: number; scale: "cet" | "ielts" }) {
  const heading = useId();
  const actualTarget = coaching?.target ?? target;
  return <section className="report-section target-coaching" aria-labelledby={heading}>
    <h2 id={heading}>按目标安排下一步</h2>
    <p className="coaching-meta">
      {coaching && <span>本次参考分：{coachingScoreLabel(coaching.currentScore, scale)}</span>}
      <span>本次学习目标：{coachingScoreLabel(actualTarget, scale)}</span>
    </p>
    <p className="small muted">目标用于安排学习建议，不改变本次估分。原表达正确时，下面的替换属于可选练习，不计为错误，也不保证加分。</p>
    {!coaching ? <p role="status">此报告尚未生成目标提升方案。再次批改时，会按该次学习目标安排建议；原报告仍可正常查看。</p>
      : coaching.status === "unavailable" ? <p role="status">{coaching.message}</p>
      : <>
        <p className="coaching-summary">{coaching.content.summary}</p>
        <div className="coaching-block">
          <h3>优先练这几件事</h3>
          <ol className="coaching-priorities">{coaching.content.priorities.map((p, i) => <li key={i}><h4>{p.focus}</h4><p>{p.reason}</p><p><strong>现在就做：</strong>{p.action}</p></li>)}</ol>
        </div>
        <div className="coaching-block">
          <h3>本篇值得保留的部分</h3>
          <p className="small muted">引句按原文展示。保留理由可能针对思路、结构或某个表达；句中其他错误仍需按批改建议修正。</p>
          {coaching.content.preserve.map((p, i) => <article className="coaching-item" key={i}><blockquote lang="en">{p.quote}</blockquote><p>{p.reason}</p></article>)}
        </div>
        {coaching.content.rewrites.length > 0 && <div className="coaching-block">
          <h3>比较几种可选表达</h3>
          {coaching.content.rewrites.map((r, i) => <article className="coaching-item" key={i}>
            <dl className="coaching-pair"><div><dt>原表达</dt><dd lang="en">{r.original}</dd></div><div><dt>可选表达</dt><dd lang="en">{r.replacement}</dd></div></dl>
            <p>{r.explanation}</p><p className="small muted"><strong>适用边界：</strong>{r.boundary}</p>
          </article>)}
        </div>}
        <div className="coaching-block">
          <h3>带到下一篇的词块与句型</h3>
          <div className="coaching-chunks">{coaching.content.chunks.map((chunk, i) => <article className="coaching-item" key={i}>
            <h4 lang="en">{chunk.pattern}</h4><p>{chunk.meaning}</p><p lang="en" className="coaching-example">{chunk.example}</p>
            <p><strong>何时使用：</strong>{chunk.whenToUse}</p><p className="small muted"><strong>不要套用：</strong>{chunk.caution}</p>
          </article>)}</div>
        </div>
        <div className="coaching-block coaching-practice">
          <h3>换个场景，试一次</h3><p className="small muted">自拟微练习 · 参考答案不唯一</p>
          <p>{coaching.content.practice.instruction}</p><p className="coaching-prompt">{coaching.content.practice.prompt}</p>
          <details><summary>查看参考答案与练习要点</summary><p lang="en">{coaching.content.practice.referenceAnswer}</p><p>{coaching.content.practice.explanation}</p></details>
        </div>
      </>}
  </section>;
}
