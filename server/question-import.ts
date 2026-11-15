import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { HttpError } from "../src/lib/http";

const run = promisify(execFile);
const maxBytes = 10_000_000;
type Job = {
  id: string;
  owner: string;
  purpose: "question" | "answer";
  status: "processing" | "completed" | "failed";
  filename: string;
  text?: string;
  error?: string;
  errorCode?: string;
  created: number;
};
export function parsePages(value: string) {
  if (!/^\d{1,2}(?:-\d{1,2})?(?:,\d{1,2}(?:-\d{1,2})?)*$/.test(value))
    throw new HttpError(400, "页码请填写为 1-3 或 1,3，每次最多识别 6 页。 ");
  let count = 0;
  for (const part of value.split(",")) {
    const [a, b = a] = part.split("-").map(Number);
    if (a < 1 || b < a || b > 200)
      throw new HttpError(400, "请填写 1-200 以内的正向页码范围。");
    count += b - a + 1;
  }
  if (count > 6)
    throw new HttpError(400, "每次最多识别 6 页，请选出需要识别的页面。");
  return value;
}
export function validDocument(bytes: Uint8Array, extension: string) {
  const b = Buffer.from(bytes);
  return extension === ".pdf"
    ? b.subarray(0, 5).toString() === "%PDF-"
    : extension === ".png"
      ? b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : [".jpg", ".jpeg"].includes(extension)
        ? b[0] === 255 && b[1] === 216 && b[2] === 255
        : extension === ".webp"
          ? b.subarray(0, 4).toString() === "RIFF" &&
            b.subarray(8, 12).toString() === "WEBP"
          : false;
}
export function documentExtension(bytes: Uint8Array) {
  return [".pdf", ".png", ".jpg", ".webp"].find((extension) => validDocument(bytes, extension));
}
type MineruPayload = { parse?: { status?: string }; error?: { code?: string } };
type CommandRunner = (command: string, args: string[], options: ExecFileOptionsWithStringEncoding) => Promise<{ stdout: string }>;
class ImportFailure extends Error {
  constructor(readonly code: string) { super(code); }
}
/** MinerU 4 returns exit 1 with JSON when a bounded wait is still pending. */
export function mineruPayload(stdout: string, exitCode = 0): MineruPayload {
  let payload: MineruPayload;
  try { payload = JSON.parse(stdout); } catch { throw new ImportFailure("parse-format"); }
  if (!payload || typeof payload !== "object") throw new ImportFailure("parse-format");
  const status = payload.parse?.status;
  const code = payload.error?.code;
  const waiting = status === "pending" || status === "parsing";
  if (exitCode !== 0 && !(exitCode === 1 && waiting && code === "parse_wait_timeout"))
    throw new ImportFailure(code || "parse-command");
  if (code && !(waiting && code === "parse_wait_timeout")) throw new ImportFailure(code);
  if (!waiting && status !== "done") throw new ImportFailure(code || "parse-failed");
  return payload;
}
const failureMessages: Record<string, string> = {
  "parse-timeout": "识别服务在限定时间内未完成，请稍后重试；也可以先手动输入文字。",
  "parse-size": "未识别到可用文字，或结果过长。请上传清晰、正向且只包含答卷的图片。",
  parse_empty: "未识别到文字，请换一张清晰、正向的图片。",
  quota_exceeded: "识别服务当前额度已用完，请稍后重试或手动输入文字。",
  invalid_api_key: "识别服务配置暂时不可用，请稍后重试。",
  file_corrupted: "文件无法读取，请重新导出图片或 PDF 后上传。",
  file_encrypted: "PDF 已加密，请解除密码后重新上传。",
  page_range_invalid: "PDF 页码范围无效，请核对文件总页数后重试。",
  "parse-service-start": "识别辅助服务暂未能启动，请稍后重试；也可以先手动输入文字。",
  "parse-service-unavailable": "识别辅助服务暂不可用，请稍后重试；也可以先手动输入文字。",
};
export function questionImporter(command: string, storageRoot: string, execute: CommandRunner = run) {
  const jobs = new Map<string, Job>();
  let doclibRecovery: { promise: Promise<void>; attemptedAt: number } | undefined;
  function ensureDoclib() {
    // Share both the start in progress and its short-lived outcome. A cold pair
    // of uploads must not start competing daemons or hammer a failed service.
    if (!doclibRecovery || Date.now() - doclibRecovery.attemptedAt > 60_000) {
      const promise = execute(command, ["server", "start"], {
        windowsHide: true, timeout: 45_000, maxBuffer: 100_000, encoding: "utf8",
      }).then(() => {}, () => { throw new ImportFailure("parse-service-start"); });
      doclibRecovery = { promise, attemptedAt: Date.now() };
    }
    return doclibRecovery.promise;
  }
  async function pollParse(args: string[]) {
    try {
      const { stdout } = await execute(command, [...args, "--wait", "12"], {
        windowsHide: true, timeout: 45_000, maxBuffer: 2_000_000, encoding: "utf8",
      });
      return mineruPayload(stdout);
    } catch (error) {
      if (error instanceof ImportFailure) throw error;
      const failure = error as { stdout?: string; code?: unknown; killed?: boolean; signal?: string };
      // Only the documented pending result is recoverable; never hide killed
      // processes, authentication failures or malformed command output.
      if (failure.killed || failure.signal) throw new ImportFailure("parse-command-timeout");
      if (typeof failure.stdout !== "string") throw new ImportFailure("parse-command");
      return mineruPayload(failure.stdout, typeof failure.code === "number" ? failure.code : -1);
    }
  }
  const response = (j: Job) =>
    Response.json(
      {
        id: j.id,
        status: j.status,
        filename: j.filename,
        purpose: j.purpose,
        text: j.text,
        error: j.error,
        errorCode: j.errorCode,
        engine: "MinerU",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  async function parse(
    job: Job,
    bytes: Uint8Array,
    extension: string,
    pages: string,
  ) {
    const dir = resolve(storageRoot, "document-imports");
    const input = resolve(dir, job.id + extension);
    const output = resolve(dir, job.id + ".md");
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(input, bytes, { mode: 0o600 });
      const args = [
        "parse",
        input,
        "--tier",
        "standard",
        "--remote",
        "--output",
        output,
        "--json",
        "--no-marker",
        ...(extension === ".pdf" ? ["--pages", pages] : []),
      ];
      // The CLI reuses the remote parse job and cache on each bounded poll.
      const deadline = Date.now() + 240_000;
      let done = false;
      let recoveryAttempted = false;
      let recoveryDeadline = 0;
      while (Date.now() < deadline) {
        let payload: MineruPayload;
        try {
          payload = await pollParse(args);
        } catch (error) {
          if (!(error instanceof ImportFailure) || error.code !== "server_not_running") throw error;
          if (!recoveryAttempted) {
            recoveryAttempted = true;
            // This starts only MinerU's doclib coordinator, retaining its existing
            // remote/API/account configuration. It never requests a model server
            // restart, local parsing, or changes any configuration.
            await ensureDoclib();
            recoveryDeadline = Date.now() + 15_000;
          }
          if (Date.now() >= recoveryDeadline) throw new ImportFailure("parse-service-unavailable");
          // server start may report "still starting" with exit 0. Allow bounded
          // readiness probes of the same parse without issuing a second start.
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        if (payload.parse?.status === "done") {
          done = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      if (!done) throw new ImportFailure("parse-timeout");
      const text = (await readFile(output, "utf8")).trim();
      if (!text || text.length > 150_000) throw new ImportFailure("parse-size");
      job.text = text;
      job.status = "completed";
    } catch (error) {
      const rawCode = error instanceof ImportFailure ? error.code : "parse-output";
      // Do not log stdout/stderr, paths, filenames or recognized student text.
      const code = /^[a-z][a-z0-9_-]{0,63}$/.test(rawCode) ? rawCode : "parse-failed";
      job.status = "failed";
      job.errorCode = code;
      job.error = failureMessages[code] || "识别服务暂未完成这份文件，请稍后重试，或手动输入文字。";
      console.warn("document-import failed", { id: job.id, purpose: job.purpose, code, durationMs: Date.now() - job.created });
    } finally {
      await Promise.allSettled([unlink(input), unlink(output)]);
    }
  }
  function assertCapacity(owner: string) {
    if ([...jobs.values()].some((j) => j.owner === owner && j.status === "processing"))
      throw new HttpError(409, "已有一份文件正在识别，请等待完成。");
    if ([...jobs.values()].filter((j) => j.status === "processing").length >= 2)
      throw new HttpError(429, "识别任务较多，请稍后再试。");
  }
  return {
    async start(
      request: Request,
      owner: string,
      purpose: "question" | "answer" = "question",
    ) {
      for (const [key, j] of jobs)
        if (Date.now() - j.created > 30 * 60000 && j.status !== "processing")
          jobs.delete(key);
      assertCapacity(owner);
      if (
        !request.headers.get("content-type")?.startsWith("multipart/form-data")
      )
        throw new HttpError(400, "请使用文件上传表单。");
      const reader = request.body?.getReader();
      if (!reader) throw new HttpError(400, "没有收到文件。");
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes + 500_000) {
          await reader.cancel();
          throw new HttpError(413, "文件不能超过 10MB。");
        }
        chunks.push(value);
      }
      const form = await new Response(Buffer.concat(chunks), {
        headers: { "Content-Type": request.headers.get("content-type")! },
      }).formData();
      const file = form.get("file");
      if (!(file instanceof File) || !file.size || file.size > maxBytes)
        throw new HttpError(
          400,
          "请选择不超过 10MB 的 PDF、PNG、JPG 或 WebP。",
        );
      const bytes = new Uint8Array(await file.arrayBuffer());
      const extension = documentExtension(bytes);
      if (!extension)
        throw new HttpError(
          400,
          /\.hei[cf]$/i.test(file.name) ? "HEIC/HEIF 照片暂不支持，请先导出为 JPG 或 PNG 后上传。" : "文件内容与格式不符，请上传 PDF、PNG、JPG 或 WebP。",
        );
      const pages = parsePages(String(form.get("pages") || "1-3"));
      // Upload parsing yields to other requests. Recheck immediately before the
      // synchronous registration so simultaneous uploads cannot overbook slots.
      assertCapacity(owner);
      const job: Job = {
        id: crypto.randomUUID(),
        owner,
        purpose,
        status: "processing",
        filename: basename(file.name)
          .replace(/[\x00-\x1f]/g, "")
          .slice(0, 160),
        created: Date.now(),
      };
      jobs.set(job.id, job);
      void parse(job, bytes, extension, pages);
      return response(job);
    },
    get(id: string, owner: string, purpose?: "question" | "answer") {
      const job = jobs.get(id);
      if (!job || job.owner !== owner || (purpose && job.purpose !== purpose))
        throw new HttpError(404, "未找到这份识别任务，请重新上传。");
      return response(job);
    },
  };
}
