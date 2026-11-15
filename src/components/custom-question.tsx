"use client";
import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  FileArrowUp,
  SpinnerGap,
  CheckCircle,
  WarningCircle,
} from "@phosphor-icons/react";
import type { EssayInput, ExamLevel, Task } from "@/lib/types";
import { Modal } from "./ui";

type Custom = NonNullable<EssayInput["customQuestion"]>;
type ImportJob = {
  id: string;
  status: "processing" | "completed" | "failed";
  filename: string;
  text?: string;
  error?: string;
};
export function cleanImportedText(text: string) {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "[题图见原文件，请核对图意]")
    .replace(/<!--[^]*?-->/g, "")
    .replace(/^#{1,6}\s*/gm, "")
    .trim();
}
export default function CustomQuestionDialog({
  open,
  onOpenChange,
  seed,
  loggedIn,
  importerAvailable,
  onLogin,
  onSave,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  seed: Custom;
  loggedIn: boolean;
  importerAvailable: boolean;
  onLogin: () => void;
  onSave: (q: Custom) => void;
}) {
  const [q, setQ] = useState(seed);
  const [raw, setRaw] = useState("");
  const [filename, setFilename] = useState("");
  const [pages, setPages] = useState("1-3");
  const [job, setJob] = useState<ImportJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const upload = useRef<HTMLInputElement>(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (job?.status !== "processing") return;
    const interval = setInterval(async () => {
      try {
        const response = await fetch(
          `/api/question-imports?id=${encodeURIComponent(job.id)}`,
          { cache: "no-store" },
        );
        const next = await response.json();
        if (!active.current) return;
        if (!response.ok)
          throw new Error(next.error || "无法读取识别进度，请重新上传。");
        setJob(next);
        if (next.status !== "processing") {
          setBusy(false);
          if (next.status === "completed")
            setRaw(cleanImportedText(next.text || ""));
          else setError(next.error || "识别失败，请尝试其他文件。");
        }
      } catch (err) {
        if (active.current) {
          setBusy(false);
          setJob(null);
          setError((err as Error).message);
        }
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [job?.id, job?.status]);
  const patch = (part: Partial<Custom>) => {
    setQ((v) => ({ ...v, ...part }));
    setError("");
  };
  async function readFile(file?: File) {
    if (!file) return;
    setError("");
    setFilename(file.name);
    const extension = file.name.split(".").pop()?.toLowerCase();
    if (["txt", "md", "markdown"].includes(extension || "")) {
      if (file.size > 150_000) {
        setError("文本题目不能超过 150KB。");
        return;
      }
      setRaw(cleanImportedText((await file.text()).replace(/^\uFEFF/, "")));
      return;
    }
    if (!loggedIn) {
      setError("PDF 和图片识别需要先登录。文本文件和粘贴题目可直接使用。");
      return;
    }
    if (!importerAvailable) {
      setError("当前服务尚未配置 MinerU，可上传文本或粘贴题目。");
      return;
    }
    if (
      file.size > 10_000_000 ||
      !["pdf", "png", "jpg", "jpeg", "webp"].includes(extension || "")
    ) {
      setError("请上传不超过 10MB 的 PDF、PNG、JPG 或 WebP。");
      return;
    }
    setBusy(true);
    setRaw("");
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("pages", pages);
      const response = await fetch("/api/question-imports", {
        method: "POST",
        body: form,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "上传失败，请重试。");
      if (active.current) setJob(data);
    } catch (err) {
      if (active.current) {
        setError((err as Error).message);
        setBusy(false);
      }
    }
  }
  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (q.stem.trim().length < 10) {
      setError("请填写完整的题目要求，至少 10 个字符。");
      return;
    }
    if (q.task === "translation" && q.sourceText.trim().length < 10) {
      setError("请填写要翻译的完整中文原文。");
      return;
    }
    if (q.task === "writing" && (q.wordMax || 0) < (q.wordMin || 0)) {
      setError("词数上限不能小于下限。");
      return;
    }
    onSave({
      ...q,
      stem: q.stem.trim(),
      sourceText: q.task === "translation" ? q.sourceText.trim() : "",
    });
  }
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="上传或填写自己的题目"
      description="先导入题面，核对识别结果，再开始练习。"
      wide
    >
      <form onSubmit={submit} className="form-stack custom-form">
        <div className="two-fields">
          <label>
            考试级别
            <select
              value={q.examType}
              onChange={(e) => {
                const examType = e.target.value as ExamLevel;
                patch({
                  examType,
                  wordMin: examType === "CET4" ? 120 : 150,
                  wordMax: examType === "CET4" ? 180 : 200,
                });
              }}
            >
              <option value="CET4">大学英语四级</option>
              <option value="CET6">大学英语六级</option>
            </select>
          </label>
          <label>
            练习任务
            <select
              value={q.task}
              onChange={(e) => patch({ task: e.target.value as Task })}
            >
              <option value="writing">英文写作</option>
              <option value="translation">段落汉译英</option>
            </select>
          </label>
        </div>
        <div className="upload-area">
          <div className="between">
            <div>
              <h3>从文件导入</h3>
              <p className="small muted">
                TXT / MD 在本机读取；PDF / 图片通过 MinerU 远程识别。
              </p>
            </div>
            <FileArrowUp size={28} weight="light" />
          </div>
          <div className="upload-controls">
            <label>
              PDF 页码
              <input
                value={pages}
                onChange={(e) => setPages(e.target.value)}
                placeholder="1-3"
                aria-label="需要识别的 PDF 页码"
              />
            </label>
            <input
              ref={upload}
              type="file"
              accept=".txt,.md,.markdown,.pdf,.png,.jpg,.jpeg,.webp"
              hidden
              onChange={(e) => {
                void readFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => upload.current?.click()}
            >
              {busy ? (
                <SpinnerGap className="spin" size={18} />
              ) : (
                <FileArrowUp size={18} />
              )}
              选择题目文件
            </button>
            {!loggedIn && (
              <button type="button" className="text-button" onClick={onLogin}>
                登录后识别 PDF / 图片
                <ArrowRight size={16} />
              </button>
            )}
          </div>
          <p className="small muted">
            PDF 和图片最大 10MB，每次最多 6
            页。只上传题目所在页；识别文本可能丢字或空格，请核对原文件。
          </p>
          {busy && (
            <div className="import-progress" role="status">
              <div className="loading-line" />
              <p>MinerU 正在识别 {filename}，可以继续编辑下方题目要求。</p>
            </div>
          )}
          {raw && (
            <div className="import-preview">
              <p className="small">
                <CheckCircle size={16} />
                已读取 {filename}，先检查是否混有答案或其他题目。
              </p>
              <label>
                导入文本
                <textarea
                  rows={7}
                  value={raw}
                  onChange={(e) => setRaw(e.target.value)}
                  maxLength={150000}
                />
              </label>
              <div className="upload-apply">
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => patch({ stem: raw.slice(0, 6000) })}
                >
                  填入题目要求
                </button>
                {q.task === "translation" && (
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => patch({ sourceText: raw.slice(0, 10000) })}
                  >
                    填入中文原文
                  </button>
                )}
              </div>
              {raw.length > 6000 && (
                <p className="small error-text">
                  导入内容较长，请在下方只保留当前这道题，移除答案与其他页面。
                </p>
              )}
            </div>
          )}
        </div>
        <label>
          题目要求 / Directions
          <textarea
            required
            minLength={10}
            maxLength={6000}
            rows={4}
            value={q.stem}
            onChange={(e) => patch({ stem: e.target.value })}
            placeholder="粘贴完整写作题目，或填写翻译任务要求。"
          />
        </label>
        {q.task === "translation" ? (
          <label>
            待翻译的中文原文
            <textarea
              required
              minLength={10}
              maxLength={10000}
              rows={6}
              value={q.sourceText}
              onChange={(e) => patch({ sourceText: e.target.value })}
              placeholder="只保留原文与题中括注，不要放入参考译文。"
            />
          </label>
        ) : (
          <div className="two-fields">
            <label>
              题面词数下限
              <input
                type="number"
                min={1}
                max={1000}
                required
                value={q.wordMin || 120}
                onChange={(e) => patch({ wordMin: Number(e.target.value) })}
              />
            </label>
            <label>
              题面词数上限
              <input
                type="number"
                min={1}
                max={2000}
                required
                value={q.wordMax || 180}
                onChange={(e) => patch({ wordMax: Number(e.target.value) })}
              />
            </label>
          </div>
        )}
        {q.task === "writing" && (
          <>
            <label className="check-label">
              <input
                type="checkbox"
                checked={q.needsVisual}
                onChange={(e) => patch({ needsVisual: e.target.checked })}
              />
              这道题依赖图画或图表
            </label>
            {q.needsVisual && (
              <label>
                图意说明或图表数据（选填）
                <textarea
                  rows={3}
                  maxLength={6000}
                  value={q.visualDescription || ""}
                  onChange={(e) => patch({ visualDescription: e.target.value })}
                  placeholder="核对原图后，填写图意或完整数据。未填写时只给语言与结构反馈。"
                />
                <span className="small muted">
                  批改将以你确认的文字说明为依据，文字识别不能代替读懂图表。
                </span>
              </label>
            )}
          </>
        )}
        {error && (
          <p className="error-box" role="alert">
            <WarningCircle size={18} />
            {error}
          </p>
        )}
        <button type="submit" className="button primary full" disabled={busy}>
          已核对，使用这道题
          <ArrowRight size={18} />
        </button>
      </form>
    </Modal>
  );
}
