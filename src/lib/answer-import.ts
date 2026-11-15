export type AnswerImportJob = {
  id: string;
  status: "processing" | "completed" | "failed";
  text?: string;
  error?: string;
};

export function supportedAnswerImage(file: Pick<File, "name" | "type" | "size">) {
  return file.size > 0 && file.size <= 10_000_000 &&
    (/\.(png|jpe?g|webp)$/i.test(file.name) || ["image/png", "image/jpeg", "image/webp"].includes(file.type));
}

export class AnswerImportRequestError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

export async function readAnswerImportJob(response: Response): Promise<AnswerImportJob> {
  let job: AnswerImportJob;
  try { job = await response.json(); }
  catch { throw new AnswerImportRequestError("暂时无法读取识别进度，请重试；已上传的任务会继续处理。", response.status); }
  if (!response.ok) throw new AnswerImportRequestError(job?.error || "暂时无法获取识别进度，请稍后重试。", response.status);
  if (!job || typeof job.id !== "string" || !["processing", "completed", "failed"].includes(job.status))
    throw new AnswerImportRequestError("识别服务返回了无效进度，请稍后重试。");
  return job;
}

/** Remove document formatting, never correct the student's English. */
export function cleanAnswerText(value: string) {
  return value
    .replace(/^\uFEFF/, "")
    .replace(/<!--[^]*?-->/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "[此处未识别，请对照原图补录]")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\r\n/g, "\n")
    .trim();
}

export function combineAnswer(
  current: string,
  recognized: string,
  mode: "append" | "replace",
) {
  const text = recognized.trim();
  if (!text) throw new Error("识别结果为空，请先补录答案。");
  const next =
    mode === "append" && current.trim()
      ? `${current.trimEnd()}\n\n${text}`
      : text;
  if (next.length > 30000)
    throw new Error("合并后超过 30000 个字符，请先删去题面和无关内容。");
  return next;
}
