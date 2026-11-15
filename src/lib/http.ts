import { ZodError } from "zod";
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "REQUEST_ERROR",
    public retryAfterSeconds?: number,
  ) {
    super(message);
  }
}
export function reviewFailureMessage(error: unknown): string {
  if (error instanceof HttpError)
    return error.code === "SCORING_INCONSISTENT"
      ? "本次评分复核未完成，草稿已保留，请稍后重试。"
      : error.message;
  return "本次批改失败，草稿已保留，请稍后重试。";
}
export function assertOrigin(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin)
    throw new HttpError(403, "请求来源不匹配，请在网站原地址操作。");
}
export async function body(request: Request, maxBytes = 5_000_000) {
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "请求内容为空。");
  let size = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, "内容太大，请缩小附件或作文。");
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "请求格式不正确。");
  }
}
export async function endpoint(action: () => Promise<unknown>) {
  try {
    return Response.json(await action(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof HttpError)
      return Response.json(
        { error: reviewFailureMessage(error), code: error.code },
        { status: error.status, headers: { "Cache-Control": "no-store", ...(error.retryAfterSeconds ? { "Retry-After": String(Math.max(1, Math.ceil(error.retryAfterSeconds))) } : {}) } },
      );
    if (error instanceof ZodError)
      return Response.json(
        { error: error.issues[0]?.message || "输入格式不正确。" },
        { status: 400 },
      );
    console.error(
      "Request failed:",
      error instanceof Error ? error.name : "UnknownError",
    );
    return Response.json(
      { error: "暂时无法完成操作，请稍后重试。" },
      { status: 500 },
    );
  }
}
