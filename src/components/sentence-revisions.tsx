"use client";

import { Fragment, useId, useState } from "react";
import {
  ArrowUpRight,
  DownloadSimple,
  NotePencil,
} from "@phosphor-icons/react";
import {
  correctionLabels,
  diffWords,
  sentenceLocation,
  type DiffPart,
  type RevisionDocument,
  type RevisionSentence,
} from "@/lib/revisions";
import { untranslatedSourceNotice } from "@/lib/translation-revisions";

function DiffText({
  parts,
  side,
  onSelect,
}: {
  parts: DiffPart[];
  side: "original" | "revised";
  onSelect?: () => void;
}) {
  return parts.map((part, index) => {
    if (part.type === "same")
      return <Fragment key={index}>{part.text}</Fragment>;
    if (side === "original" && part.type === "added") {
      if (parts[index - 1]?.type === "removed") return null;
      return onSelect ? (
        <button
          key={index}
          className="insertion-slot"
          onClick={onSelect}
          aria-label="此处建议补充文字，点击查看改句"
          title="此处建议补充文字"
        >
          +
        </button>
      ) : (
        <span
          key={index}
          className="insertion-slot"
          role="img"
          aria-label="此处建议补充文字"
        >
          +
        </span>
      );
    }
    if (side === "revised" && part.type === "removed") return null;
    if (onSelect)
      return (
        <button
          key={index}
          className="original-annotation"
          onClick={onSelect}
          aria-label={`查看“${part.text.trim() || "空格"}”的修改`}
          title="点击查看对应改句"
        >
          {part.text}
        </button>
      );
    return (
      <mark key={index} className={`revision-${part.type}`}>
        {part.text}
      </mark>
    );
  });
}

function TranslationSource({ sources }: { sources: string[] }) {
  return (
    <div className="sentence-version sentence-source">
      <span className="version-label">中文原句</span>
      <p className="sentence-prose" lang="zh-CN">{sources.join("\n") || untranslatedSourceNotice}</p>
    </div>
  );
}

function SentencePair({
  parts,
  original,
  revised,
  translation,
}: {
  parts: DiffPart[];
  original: string;
  revised: string;
  translation?: boolean;
}) {
  return (
    <>
      <div className="sentence-version sentence-before">
        <span className="version-label">{translation ? "我的译句" : "原句"}</span>
        <p
          className="sentence-prose"
          lang="en"
          aria-label={`${translation ? "我的译句" : "原句"}：${original}`}
        >
          <DiffText parts={parts} side="original" />
        </p>
      </div>
      <div className="sentence-version sentence-after">
        <span className="version-label">修改后</span>
        <p
          className="sentence-prose"
          lang={revised ? "en" : "zh-CN"}
          aria-label={`修改后：${revised || "建议删除这一句"}`}
        >
          {revised ? (
            <DiffText parts={parts} side="revised" />
          ) : (
            <span className="muted">建议删除这一句</span>
          )}
        </p>
      </div>
    </>
  );
}

function SentenceCard({
  sentence,
  active,
  onLocate,
  translation,
}: {
  sentence: RevisionSentence;
  active: boolean;
  onLocate: () => void;
  translation?: boolean;
}) {
  return (
    <article
      id={`revision-${sentence.id}`}
      tabIndex={-1}
      className={`sentence-revision${active ? " is-target" : ""}`}
      aria-label={`${sentenceLocation(sentence)}的修改`}
    >
      <header className="sentence-heading">
        <span
          className="sentence-number"
          aria-label={`标注 ${sentence.annotation}`}
        >
          {sentence.annotation}
        </span>
        <h3>{sentenceLocation(sentence)}</h3>
        <button className="text-button locate-original" onClick={onLocate}>
          定位原文 <ArrowUpRight size={15} />
        </button>
      </header>
      {translation && <TranslationSource sources={sentence.translationSources || []} />}
      <SentencePair
        parts={sentence.parts}
        original={sentence.original}
        revised={sentence.revised}
        translation={translation}
      />
      <div className="sentence-explanations">
        <span className="version-label">为什么改</span>
        <ul>
          {sentence.corrections.map((c, i) => (
            <li key={i}>
              <span className="correction-kind">
                {correctionLabels[c.kind]}
              </span>
              <span>{c.reason || "本条建议未提供具体理由。"}</span>
            </li>
          ))}
        </ul>
      </div>
    </article>
  );
}

function RevisionLegend() {
  return (
    <div className="revision-legend" aria-label="修改标记说明">
      <span>
        <mark className="revision-removed">原文改动</mark>
      </span>
      <span>
        <mark className="revision-added">替换或补充</mark>
      </span>
      <span>+ 建议补充的位置</span>
    </div>
  );
}

const unplacedLabels = {
  ambiguous: "这段引用在原文中出现多次，请结合上下文核对。",
  not_found: "这段引用与提交原文不完全一致，请先核对原句。",
  overlap: "同一处有不同改法，以下建议单独展示，未与其他改动叠加。",
  context: "这条建议涉及多处上下文，单独保留供你核对。",
};

export function SentenceRevisions({
  document,
  activeId,
  onLocate,
  onDownload,
}: {
  document: RevisionDocument;
  activeId: string | null;
  onLocate: (id: string) => void;
  onDownload: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const headingId = useId();
  const changed = document.sentences.filter((s) => s.corrections.length);
  const visible = showAll ? document.sentences : changed;
  return (
    <section
      className={`report-section revision-section${document.translation ? " translation-revisions" : ""}`}
      aria-labelledby={headingId}
    >
      <div className="revision-heading">
        <h2 id={headingId}>
          <NotePencil size={22} />
          逐句修改
        </h2>
        <span className="revision-count">{changed.length} 句有修改建议</span>
      </div>
      <p className="revision-intro">
        {document.translation
          ? "每条先对照中文原句，再看我的译句、修改后与修改原因。只突出英文有变化的部分。"
          : "按原文顺序对照。原句在上，改句在下，只突出有变化的部分。"}
      </p>
      <RevisionLegend />
      <div className="revision-toolbar">
        <div
          className="segment revision-filter"
          role="group"
          aria-label="句子显示方式"
        >
          <button aria-pressed={!showAll} onClick={() => setShowAll(false)}>
            只看修改
          </button>
          <button aria-pressed={showAll} onClick={() => setShowAll(true)}>
            显示全文
          </button>
        </div>
        <button className="text-button revision-download" onClick={onDownload}>
          <DownloadSimple size={16} />
          下载逐句对照
        </button>
      </div>
      {!changed.length && !showAll && (
        <div className="revision-empty" role="status">
          <h3>本次报告未列出可定位的逐句修改</h3>
          <p>
            可切换到“显示全文”查看原文，或阅读“批改建议”。未标注不代表句子已确认无误。
          </p>
        </div>
      )}
      <div className="sentence-revision-list">
        {visible.map((sentence) =>
          sentence.corrections.length ? (
            <SentenceCard
              key={sentence.id}
              sentence={sentence}
              active={activeId === sentence.id}
              onLocate={() => onLocate(sentence.id)}
              translation={document.translation}
            />
          ) : (
            <article className="sentence-unchanged" key={sentence.id}>
              <h3>
                {sentenceLocation(sentence)}
                <span>未标注修改</span>
              </h3>
              {document.translation && <TranslationSource sources={sentence.translationSources || []} />}
              <p className="sentence-prose" lang="en">
                {sentence.original}
              </p>
            </article>
          ),
        )}
      </div>
      {document.unplaced.length > 0 && (
        <div className="unplaced-revisions">
          <h3>另外 {document.unplaced.length} 条建议，需核对上下文</h3>
          {document.unplaced.map(({ correction: c, reason, translationSources }, index) => (
            <article className="sentence-revision" key={index}>
              <p className="unplaced-note">{unplacedLabels[reason]}</p>
              {document.translation && <TranslationSource sources={translationSources || []} />}
              <SentencePair
                parts={diffWords(c.original, c.replacement)}
                original={c.original}
                revised={c.replacement}
                translation={document.translation}
              />
              <div className="sentence-explanations">
                <span className="version-label">为什么改</span>
                <p>
                  <span className="correction-kind">
                    {correctionLabels[c.kind]}
                  </span>
                  {c.reason}
                </p>
              </div>
            </article>
          ))}
        </div>
      )}
      {showAll && (
        <p className="revision-footnote">
          仅显示本次报告提供的修改建议，未标注的句子保留原文。
        </p>
      )}
    </section>
  );
}

export function AnnotatedOriginal({
  document,
  essay,
  activeId,
  onOpen,
  onDownload,
}: {
  document: RevisionDocument;
  essay: string;
  activeId: string | null;
  onOpen: (id: string) => void;
  onDownload: () => void;
}) {
  const headingId = useId();
  return (
    <section
      className="report-section revision-section"
      aria-labelledby={headingId}
    >
      <div className="revision-heading">
        <h2 id={headingId}>我的原文与修改标注</h2>
        <button className="text-button" onClick={onDownload}>
          <DownloadSimple size={16} />
          下载原文
        </button>
      </div>
      <p className="revision-intro">
        点击标出的词句或右上角编号，即可查看对应改句和修改原因。
      </p>
      <RevisionLegend />
      <div className="annotated-essay" lang="en">
        {document.paragraphs.map((paragraph) => (
          <p key={paragraph.index} className="annotated-paragraph">
            {paragraph.sentences.map((sentence, index) => (
              <Fragment key={sentence.id}>
                {index > 0 &&
                  essay.slice(
                    paragraph.sentences[index - 1].end,
                    sentence.start,
                  )}
                <span
                  id={`source-${sentence.id}`}
                  tabIndex={-1}
                  className={`annotated-sentence${sentence.id === activeId ? " is-target" : ""}`}
                >
                  <DiffText
                    parts={sentence.parts}
                    side="original"
                    onSelect={() => onOpen(sentence.id)}
                  />
                  {sentence.annotation !== null && (
                    <sup>
                      <button
                        className="annotation-index"
                        onClick={() => onOpen(sentence.id)}
                        aria-label={`查看${sentenceLocation(sentence)}的修改`}
                      >
                        {sentence.annotation}
                      </button>
                    </sup>
                  )}
                </span>
              </Fragment>
            ))}
          </p>
        ))}
      </div>
      {document.unplaced.length > 0 && (
        <p className="revision-footnote">
          另有 {document.unplaced.length}{" "}
          条建议需核对上下文，可在“逐句修改”中查看。
        </p>
      )}
    </section>
  );
}
