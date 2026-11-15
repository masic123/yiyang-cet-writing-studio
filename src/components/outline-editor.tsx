"use client";
import { useState } from "react";
import {
  ArrowRight,
  CaretDown,
  CaretUp,
  DownloadSimple,
  FloppyDisk,
  Plus,
  X,
} from "@phosphor-icons/react";
import type { Question, WritingOutline } from "@/lib/types";
import {
  blankOutline,
  hasOutline,
  outlineGuide,
  outlineText,
} from "@/lib/outline";
import { downloadText } from "./report";

export default function OutlineEditor({
  value,
  question,
  disabled,
  saving,
  onChange,
  onSave,
  onWrite,
}: {
  value?: WritingOutline;
  question: Question;
  disabled: boolean;
  saving: boolean;
  onChange: (outline: WritingOutline) => void;
  onSave: () => void;
  onWrite: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const plan = value || blankOutline();
  const guide = outlineGuide(question);
  const patch = (change: Partial<WritingOutline>) =>
    onChange({ ...plan, ...change });
  const paragraphPatch = (
    id: string,
    change: { point?: string; support?: string },
  ) =>
    patch({
      paragraphs: plan.paragraphs.map((p) =>
        p.id === id ? { ...p, ...change } : p,
      ),
    });
  return (
    <section className="outline-panel" aria-labelledby="outline-title">
      <div className="outline-heading">
        <div className="question-title">
          <span className="section-index">02</span>
          <h2 id="outline-title">
            {question.task === "translation"
              ? "拆分意群，理清句子关系"
              : "列好提纲，再开始表达"}
          </h2>
        </div>
        <button
          className="text-button"
          aria-expanded={expanded}
          aria-controls="outline-body"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "收起提纲" : "展开提纲"}
          {expanded ? <CaretUp size={15} /> : <CaretDown size={15} />}
        </button>
      </div>
      <div id="outline-body" hidden={!expanded}>
        <p className="outline-intro">可以用中文或英文记录。{guide.note}</p>
        <div className="outline-fields">
          <label htmlFor="outline-analysis">
            {guide.analysis}
            <textarea
              id="outline-analysis"
              rows={2}
              maxLength={2000}
              placeholder={guide.analysisHint}
              value={plan.analysis}
              onChange={(e) => patch({ analysis: e.target.value })}
              disabled={disabled}
            />
          </label>
          <label htmlFor="outline-position">
            {guide.position}
            <textarea
              id="outline-position"
              rows={2}
              maxLength={2000}
              placeholder={guide.positionHint}
              value={plan.position}
              onChange={(e) => patch({ position: e.target.value })}
              disabled={disabled}
            />
          </label>
        </div>
        <div className="outline-paragraphs">
          {plan.paragraphs.map((paragraph, i) => (
            <fieldset key={paragraph.id}>
              <legend>
                {guide.paragraph} {i + 1}
              </legend>
              <button
                className="icon-button outline-remove"
                aria-label={`移除${guide.paragraph} ${i + 1}`}
                disabled={disabled}
                onClick={() =>
                  patch({
                    paragraphs: plan.paragraphs.filter(
                      (p) => p.id !== paragraph.id,
                    ),
                  })
                }
              >
                <X size={16} />
              </button>
              <label htmlFor={`outline-point-${paragraph.id}`}>
                {guide.point}
                <textarea
                  id={`outline-point-${paragraph.id}`}
                  rows={2}
                  maxLength={2000}
                  placeholder={guide.pointHint}
                  value={paragraph.point}
                  onChange={(e) =>
                    paragraphPatch(paragraph.id, { point: e.target.value })
                  }
                  disabled={disabled}
                />
              </label>
              <label htmlFor={`outline-support-${paragraph.id}`}>
                {guide.support}
                <textarea
                  id={`outline-support-${paragraph.id}`}
                  rows={3}
                  maxLength={3000}
                  placeholder={guide.supportHint}
                  value={paragraph.support}
                  onChange={(e) =>
                    paragraphPatch(paragraph.id, { support: e.target.value })
                  }
                  disabled={disabled}
                />
              </label>
            </fieldset>
          ))}
        </div>
        <button
          className="text-button outline-add"
          disabled={disabled || plan.paragraphs.length >= 8}
          onClick={() =>
            patch({
              paragraphs: [
                ...plan.paragraphs,
                { id: crypto.randomUUID(), point: "", support: "" },
              ],
            })
          }
        >
          <Plus size={16} />
          添加一个{guide.paragraph}
        </button>
        <div className="outline-ending">
          <label htmlFor="outline-ending">
            {guide.ending}
            <textarea
              id="outline-ending"
              rows={2}
              maxLength={2000}
              placeholder={guide.endingHint}
              value={plan.ending}
              onChange={(e) => patch({ ending: e.target.value })}
              disabled={disabled}
            />
          </label>
        </div>
        <div className="outline-actions">
          <button
            className="button secondary"
            disabled={disabled || saving}
            onClick={onSave}
          >
            <FloppyDisk size={17} />
            保存提纲
          </button>
          <button
            className="icon-button"
            aria-label="下载提纲"
            title="下载提纲"
            disabled={!hasOutline(value)}
            onClick={() =>
              downloadText(
                outlineText(plan, question),
                "四六级写译-写前提纲.txt",
              )
            }
          >
            <DownloadSimple size={18} />
          </button>
          <button className="text-button" onClick={onWrite} disabled={disabled}>
            开始写正文
            <ArrowRight size={17} />
          </button>
        </div>
        <p className="outline-save-note small muted">
          提纲随草稿保存在本机，登录后可保存到账号。提纲不计入正文字数与评分。
        </p>
      </div>
    </section>
  );
}
