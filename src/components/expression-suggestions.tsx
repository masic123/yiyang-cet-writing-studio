import { useId } from "react";
import type { ExpressionSuggestion } from "@/lib/types";

const groups = [
  ["vocabulary", "词汇选择"],
  ["phrase", "短语与搭配"],
  ["sentence", "句式练习"],
] as const;

export default function ExpressionSuggestions({
  suggestions = [],
}: {
  suggestions?: ExpressionSuggestion[];
}) {
  const headingId = useId();
  if (!suggestions.length) return null;
  return (
    <section className="report-section expression-suggestions" aria-labelledby={headingId}>
      <h2 id={headingId}>表达进阶</h2>
      <p className="small muted">
        结合本次作答，练习更准确、自然的表达。原表达正确时，替换属于可选练习，不计为错误，也不保证加分。
      </p>
      {groups.map(([kind, label]) => {
        const items = suggestions.filter((s) => s.kind === kind);
        if (!items.length) return null;
        return (
          <div className="expression-group" key={kind}>
            <h3>{label}</h3>
            {items.map((s, i) => (
              <article className="expression-item" key={i}>
                <dl className="expression-pair">
                  <div><dt>原表达</dt><dd lang="en">{s.original}</dd></div>
                  <div><dt>建议表达</dt><dd lang="en">{s.replacement}</dd></div>
                </dl>
                <p className="expression-explanation">{s.explanation}</p>
                <dl className="expression-example">
                  <div><dt>用法例句</dt><dd lang="en">{s.example}</dd></div>
                </dl>
              </article>
            ))}
          </div>
        );
      })}
    </section>
  );
}
