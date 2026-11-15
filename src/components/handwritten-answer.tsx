"use client";
import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  CheckCircle,
  FileArrowUp,
  SpinnerGap,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react";
import { AnswerImportRequestError, cleanAnswerText, combineAnswer, readAnswerImportJob, supportedAnswerImage, type AnswerImportJob } from "@/lib/answer-import";
import { wordCount } from "@/lib/types";
import { Modal } from "./ui";

type Page = {
  id: string;
  file: File;
  preview: string;
  status: "ready" | "processing" | "completed" | "failed";
  text: string;
  error?: string;
  jobId?: string;
};

export default function HandwrittenAnswerDialog({
  open,
  onOpenChange,
  loggedIn,
  importerAvailable,
  onLogin,
  currentEssay,
  onApply,
  onBusyChange,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  loggedIn: boolean;
  importerAvailable: boolean;
  onLogin: () => void;
  currentEssay: string;
  onApply: (text: string) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [pages, setPages] = useState<Page[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [verified, setVerified] = useState(false);
  const [mode, setMode] = useState<"append" | "replace">("append");
  const upload = useRef<HTMLInputElement>(null);
  const urls = useRef(new Set<string>());
  const controller = useRef<AbortController | null>(null);
  const active = useRef(true);
  const combined = pages
    .map((p) => p.text.trim())
    .filter(Boolean)
    .join("\n\n");
  const completed =
    pages.length > 0 && pages.every((p) => p.status === "completed");
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      controller.current?.abort();
      onBusyChange(false);
      urls.current.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);
  function patch(id: string, changes: Partial<Page>) {
    if (active.current)
      setPages((all) =>
        all.map((p) => (p.id === id ? { ...p, ...changes } : p)),
      );
  }
  function addFiles(files: FileList | null) {
    if (!files) return;
    const incoming = [...files];
    if (incoming.length + pages.length > 6) {
      setError("一次最多选择 6 张答卷图片，请分批导入。");
      return;
    }
    if (incoming.some((file) => !supportedAnswerImage(file))) {
      setError(
        "请选择 PNG、JPG 或 WebP 图片，每张不超过 10MB。手机 HEIC 照片请先导出为 JPG。",
      );
      return;
    }
    const fresh = incoming.filter(
      (f) =>
        !pages.some(
          (p) =>
            p.file.name === f.name &&
            p.file.size === f.size &&
            p.file.lastModified === f.lastModified,
        ),
    );
    setPages((all) => [
      ...all,
      ...fresh.map((file) => {
        const preview = URL.createObjectURL(file);
        urls.current.add(preview);
        return {
          id: crypto.randomUUID(),
          file,
          preview,
          text: "",
          status: "ready" as const,
        };
      }),
    ]);
    setVerified(false);
    setError("");
  }
  function move(index: number, direction: number) {
    setPages((all) => {
      const next = [...all];
      [next[index], next[index + direction]] = [
        next[index + direction],
        next[index],
      ];
      return next;
    });
    setVerified(false);
  }
  async function recognize() {
    if (!loggedIn) {
      onLogin();
      return;
    }
    if (!importerAvailable) {
      setError("当前服务尚未配置 MinerU，可先手动输入或导入 TXT 正文。");
      return;
    }
    setError("");
    setVerified(false);
    setBusy(true);
    onBusyChange(true);
    const abort = new AbortController();
    controller.current = abort;
    try {
      for (const page of pages) {
        if (page.status === "completed") continue;
        patch(page.id, { status: "processing", error: undefined });
        let jobId = page.jobId;
        try {
          let job: AnswerImportJob;
          if (jobId) {
            job = await readAnswerImportJob(await fetch(`/api/answer-imports?id=${encodeURIComponent(jobId)}`, {
              cache: "no-store", signal: abort.signal,
            }));
          } else {
            const form = new FormData();
            form.set("file", page.file);
            job = await readAnswerImportJob(await fetch("/api/answer-imports", {
              method: "POST", body: form, signal: abort.signal,
            }));
            jobId = job.id;
            patch(page.id, { jobId });
          }
          const deadline = Date.now() + 270_000;
          while (job.status === "processing" && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 2500));
            if (abort.signal.aborted) return;
            const poll = await fetch(
              `/api/answer-imports?id=${encodeURIComponent(job.id)}`,
              { cache: "no-store", signal: abort.signal },
            );
            job = await readAnswerImportJob(poll);
          }
          if (job.status === "failed") jobId = undefined;
          if (job.status !== "completed")
            throw new Error(job.error || "识别超时，请稍后重试。");
          jobId = undefined;
          const text = cleanAnswerText(job.text || "");
          if (!text)
            throw new Error("未识别到文字，请换一张清晰、正向的图片。");
          patch(page.id, { status: "completed", text, jobId: undefined });
        } catch (err) {
          if (abort.signal.aborted) return;
          if (err instanceof AnswerImportRequestError && err.status === 404) jobId = undefined;
          const message = err instanceof TypeError ? "网络连接中断，请重试；已上传的识别任务会继续处理。" : (err as Error).message;
          patch(page.id, { status: "failed", jobId, error: message });
          // Preserve previous pages; stop so the learner can fix this page before continuing.
          setError(message);
          break;
        }
      }
    } finally {
      if (active.current) {
        setBusy(false);
        onBusyChange(false);
      }
    }
  }
  function apply() {
    try {
      if (!verified || !completed) return;
      onApply(combineAnswer(currentEssay, combined, mode));
      onOpenChange(false);
      setPages([]);
      setVerified(false);
      setError("");
      urls.current.forEach((url) => URL.revokeObjectURL(url));
      urls.current.clear();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="从手写答卷导入正文"
      description="作文和翻译都可以。上传答卷照片，逐页核对文字，再填入英文作答。"
      wide
    >
      <div className="form-stack handwritten-form">
        <div className="upload-area">
          <h3>选择清晰的答卷图片</h3>
          <p className="small muted">
            一次最多 6 张，按正文顺序排列。支持 PNG / JPG / WebP，每张不超过
            10MB。拍照时保持正向，拍全段落，尽量避开阴影。
          </p>
          <input
            ref={upload}
            type="file"
            multiple
            accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
            hidden
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <div className="upload-apply">
            <button
              className="button secondary"
              disabled={busy || pages.length >= 6}
              onClick={() => upload.current?.click()}
            >
              <FileArrowUp size={18} />
              选择答卷图片
            </button>
            {!loggedIn && (
              <button className="text-button" onClick={onLogin}>
                登录后开始识别
                <ArrowRight size={16} />
              </button>
            )}
          </div>
          <p className="small muted">
            图片将交给 MinerU
            远程识别，识别后本服务删除临时文件。核对完成的文字按普通正文保存；照片只在当前窗口预览。请先裁去姓名、学号等无关信息。
          </p>
        </div>
        {pages.length > 0 && (
          <ol className="answer-pages">
            {pages.map((page, index) => (
              <li key={page.id} className="answer-page">
                <div className="answer-page-heading">
                  <strong>第 {index + 1} 页</strong>
                  <span className="small muted answer-filename">
                    {page.file.name}
                  </span>
                  <div className="answer-order-tools">
                    <button
                      className="icon-button"
                      disabled={busy || index === 0}
                      aria-label={`第 ${index + 1} 页上移`}
                      onClick={() => move(index, -1)}
                    >
                      <ArrowUp size={17} />
                    </button>
                    <button
                      className="icon-button"
                      disabled={busy || index === pages.length - 1}
                      aria-label={`第 ${index + 1} 页下移`}
                      onClick={() => move(index, 1)}
                    >
                      <ArrowDown size={17} />
                    </button>
                    <button
                      className="icon-button"
                      disabled={busy}
                      aria-label={`移除第 ${index + 1} 页`}
                      onClick={() => {
                        URL.revokeObjectURL(page.preview);
                        urls.current.delete(page.preview);
                        setPages((all) => all.filter((p) => p.id !== page.id));
                        setVerified(false);
                      }}
                    >
                      <Trash size={17} />
                    </button>
                  </div>
                </div>
                <div className="answer-compare">
                  {/* Local object URLs are deliberately shown without a remote image optimizer. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <a
                    href={page.preview}
                    target="_blank"
                    rel="noreferrer"
                    className="answer-photo"
                  >
                    <img
                      src={page.preview}
                      alt={`第 ${index + 1} 页答卷原图，点击放大`}
                    />
                    <span className="small">点击原图放大核对</span>
                  </a>
                  <div className="answer-transcript">
                    {page.status === "processing" ? (
                      <p className="import-progress" role="status">
                        <SpinnerGap size={18} className="spin" />
                        MinerU 正在识别第 {index + 1} 页…
                      </p>
                    ) : page.status === "failed" ? (
                      <p className="error-text" role="alert">
                        {page.error}
                      </p>
                    ) : page.status === "ready" ? (
                      <p className="small muted">
                        等待识别。先确认页序，再点击下方“开始识别”。
                      </p>
                    ) : (
                      <label>
                        第 {index + 1} 页识别正文
                        <textarea
                          lang="en"
                          spellCheck={false}
                          rows={9}
                          maxLength={30000}
                          value={page.text}
                          onChange={(e) => {
                            patch(page.id, { text: e.target.value });
                            setVerified(false);
                          }}
                        />
                        <span className="small muted">
                          {wordCount(page.text)} 词 ·
                          只保留英文答案，删去题面和页码；保留你原来的拼写、语法与标点。
                        </span>
                      </label>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
        {!completed && (
          <button
            className="button primary"
            disabled={busy || !pages.length || (loggedIn && !importerAvailable)}
            onClick={() => void recognize()}
          >
            {busy ? (
              <SpinnerGap size={18} className="spin" />
            ) : (
              <FileArrowUp size={18} />
            )}
            {busy
              ? `正在识别 · ${pages.filter((p) => p.status === "completed").length}/${pages.length} 页完成`
              : pages.some((p) => p.status === "failed")
                ? "重试未完成的图片"
                : "开始识别"}
          </button>
        )}
        {loggedIn && !importerAvailable && (
          <p className="small error-text">
            当前服务尚未配置 MinerU，暂时无法识别图片。
          </p>
        )}
        {completed && (
          <div className="answer-confirm form-stack">
            <p className="small">
              <CheckCircle size={17} />
              {pages.length} 页已识别，共 {wordCount(combined)}{" "}
              词。请对照原图核对，尤其是漏字、拼写、涂改和段落顺序。
            </p>
            <p className="small muted">
              批改以你确认的文字为依据，不评价笔迹与卷面。识别可能改错或漏字，请保留原答案的错误，才能得到有用的反馈。
            </p>
            {currentEssay.trim() && (
              <fieldset className="answer-merge">
                <legend>编辑区已有正文，如何导入？</legend>
                <label>
                  <input
                    type="radio"
                    name="answer-mode"
                    checked={mode === "append"}
                    onChange={() => setMode("append")}
                  />
                  追加到现有正文末尾
                </label>
                <label>
                  <input
                    type="radio"
                    name="answer-mode"
                    checked={mode === "replace"}
                    onChange={() => setMode("replace")}
                  />
                  替换现有正文
                </label>
              </fieldset>
            )}
            <label className="check-label">
              <input
                type="checkbox"
                checked={verified}
                onChange={(e) => setVerified(e.target.checked)}
              />
              我已对照原图核对文字，保留了原答案的拼写和语法
            </label>
            <button
              className="button primary full"
              disabled={!verified || !combined.trim()}
              onClick={apply}
            >
              确认并填入正文
              <ArrowRight size={18} />
            </button>
          </div>
        )}
        {error && (
          <p className="error-box" role="alert">
            <WarningCircle size={18} />
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
