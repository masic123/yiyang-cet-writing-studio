import type { Review } from "./types";

export function reviewProgress(review: Pick<Review, "status" | "queue">) {
  if (review.status === "completed") return { label: "已完成", title: "批改已完成", description: "报告已保存到你的账号。" };
  if (review.status === "failed") return { label: "未完成", title: "本次批改未完成", description: "作答已保存，可以稍后重试。" };
  if (review.queue?.state === "queued") return {
    label: "等待批改", title: "作答已提交，等待批改",
    description: review.queue.position > 1 ? `当前排队第 ${review.queue.position} 位。可以离开本页，稍后在“我的练习”查看报告。` : "正在等待空闲名额。可以离开本页，稍后在“我的练习”查看报告。",
  };
  if (review.queue?.state === "retrying") return { label: "等待重试", title: "批改服务暂忙，正在安排重试", description: "作答已保存，请勿重复提交。重试完成后报告会保存在账号里。" };
  return { label: "正在批改", title: "正在阅读你的作答", description: "完成后报告会保存在账号里，可以稍后从“我的练习”查看。" };
}

/** One request at a time; stopped or timed-out requests never update a later view. */
export function pollReview<T extends { status: string }>(options: {
  read(signal: AbortSignal): Promise<T>;
  receive(review: T): void;
  problem(message: string, stopped?: boolean): void;
  visible?: () => boolean;
  intervalMs?: number;
  timeoutMs?: number;
}) {
  let stopped = false, failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: AbortController | undefined;
  const schedule = (delay: number) => { if (!stopped) timer = setTimeout(() => { void tick(); }, delay); };
  const tick = async () => {
    const controller = current = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 12000);
    try {
      const review = await options.read(controller.signal);
      if (stopped || controller.signal.aborted) return;
      failures = 0;
      options.problem("");
      options.receive(review);
      if (review.status !== "processing") { stopped = true; return; }
    } catch (error) {
      if (stopped) return;
      failures++;
      const status = Number((error as { status?: number })?.status);
      if (status === 401 || status === 403 || status === 404) {
        options.problem(status === 401 ? "请重新登录后，在“我的练习”查看批改结果。" : "暂时无法读取这份报告，可以回到“我的练习”重新打开；当前作答已保留。", true);
        stopped = true;
        return;
      }
      options.problem("暂时无法刷新状态，批改仍在后台进行；连接恢复后会继续更新。");
    } finally {
      clearTimeout(timeout);
      if (!stopped) schedule(options.visible?.() === false ? 15000 : Math.min(30000, (options.intervalMs ?? 4000) * 2 ** Math.min(failures, 3)));
    }
  };
  schedule(250);
  return () => { stopped = true; clearTimeout(timer); current?.abort(); };
}


export type ReviewViewToken = { scope: string; epoch: number };
type ReviewSummary = { id: string; status: string };
export type ReviewSubmissionToken = { scope: string; sequence: number; selection: ReviewViewToken };
/** Synchronous selection and submission ownership close the gap before React effects clean up. */
export function createReviewViewState() {
  let scope = "", epoch = 0, sequence = 0;
  let selected: { token: ReviewViewToken; id: string | null; status: string | null; blocked: boolean } | undefined;
  let pending: ReviewSubmissionToken | undefined;
  const ensure = (nextScope: string) => {
    if (scope !== nextScope) { scope = nextScope; selected = undefined; pending = undefined; epoch++; }
  };
  const owns = (token: ReviewViewToken, currentScope: string) => {
    ensure(currentScope);
    return token.scope === scope && selected?.token.epoch === token.epoch;
  };
  const choose = (currentScope: string, review: ReviewSummary | null) => {
    ensure(currentScope);
    const token = { scope, epoch: ++epoch };
    selected = { token, id: review?.id ?? null, status: review?.status ?? null, blocked: false };
    return token;
  };
  const accept = (token: ReviewViewToken, review: ReviewSummary, currentScope: string) => {
    if (!owns(token, currentScope)) return false;
    selected = { token, id: review.id, status: review.status, blocked: false };
    return true;
  };
  return {
    choose,
    beginOpen(currentScope: string, id: string) { return choose(currentScope, { id, status: "opening" }); },
    capture(currentScope: string, id: string) { ensure(currentScope); return selected?.id === id ? selected.token : undefined; },
    owns,
    accept,
    beginSubmission(currentScope: string) {
      const selection = choose(currentScope, null);
      pending = { scope, sequence: ++sequence, selection };
      return pending;
    },
    finishSubmission(token: ReviewSubmissionToken, review: ReviewSummary | undefined, currentScope: string) {
      ensure(currentScope);
      if (pending?.scope !== token.scope || pending.sequence !== token.sequence) return false;
      pending = undefined;
      return review ? accept(token.selection, review, currentScope) : owns(token.selection, currentScope);
    },
    block(token: ReviewViewToken, currentScope: string) {
      if (owns(token, currentScope) && selected) selected.blocked = true;
    },
    busy(currentScope: string) {
      ensure(currentScope);
      return !!pending || !!selected && selected.status === "processing" && !selected.blocked;
    },
  };
}
