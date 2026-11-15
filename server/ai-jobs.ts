import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, chmodSync, lstatSync } from "node:fs";
import { dirname } from "node:path";
import { HttpError, reviewFailureMessage } from "../src/lib/http";
import type { AiJobs, ReviewQueueInfo } from "../src/lib/ai-jobs";

type QueueRow = {
  seq: number; id: string; kind: "review" | "interactive"; site: string; owner: string;
  review_id: string | null; state: "queued" | "retrying" | "running" | "succeeded" | "failed";
  created_at: number; ready_at: number; expires_at: number; attempt: number;
  lease_token: string | null; lease_until: number; run_deadline: number;
  failure_pending: number; last_error: string | null;
};
export type AiJobOptions = {
  maxConcurrent?: number; maxQueued?: number; maxQueueMs?: number; maxRunMs?: number;
  leaseMs?: number; pollMs?: number; recoverMs?: number; retryBaseMs?: number;
  now?: () => number;
};
export type AiJobSnapshot = {
  running: number; queued: number; retrying: number; failed: number; completed: number;
  concurrency: number; maxPending: number; oldestQueuedMs: number;
};
export type AiJobConfiguration = {
  path: string; site: string;
  executeReview(owner: string, id: string, signal: AbortSignal, stillOwned: () => boolean): Promise<void>;
  failReview(owner: string, id: string, message: string): Promise<void>;
  recoverReviews(): Promise<{ owner: string; id: string; createdAt?: string }[]>;
  options?: AiJobOptions;
};

const timeoutMessage = "批改等待或处理超时，本次作答已保留，请稍后重试。";
const interruptedMessage = "批改任务中断，本次作答已保留，请稍后重试。";
const retryQueueFullMessage = "当前等待任务已满，本次未自动重试。作答已保留，请稍后重试。";
function bounded(value: number | undefined, fallback: number, maximum: number) {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < 1 || selected > maximum) throw new Error("Invalid AI queue policy");
  return selected;
}
function busyError() {
  return Object.assign(new HttpError(429, "当前批改任务较多，请稍后再试。你的作答已保留。", "AI_QUEUE_FULL"), { retryAfterSeconds: 5 });
}
function canRetry(error: unknown) {
  return error instanceof HttpError && [503, 504].includes(error.status) &&
    ["PROVIDER_BUSY", "PROVIDER_TIMEOUT", "AI_JOB_TIMEOUT"].includes(error.code);
}

/**
 * Both sites open this separate database on their existing shared local volume.
 * All claims and admission checks are one SQLite transaction, including interactive AI work.
 * A callback must honor its abort signal and check stillOwned immediately before saving a result.
 */
export function createAiJobs(configuration: AiJobConfiguration) {
  const { path, site, executeReview, failReview, recoverReviews } = configuration;
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(site)) throw new Error("Invalid AI queue site");
  const options = configuration.options ?? {};
  const now = options.now ?? Date.now;
  const maxConcurrent = bounded(options.maxConcurrent, 12, 32);
  const maxQueued = bounded(options.maxQueued, 30, 500);
  const maxQueueMs = bounded(options.maxQueueMs, 15 * 60_000, 60 * 60_000);
  const maxRunMs = bounded(options.maxRunMs, 240_000, 10 * 60_000);
  const leaseMs = bounded(options.leaseMs, 30_000, 60_000);
  const pollMs = bounded(options.pollMs, 250, 10_000);
  const recoverMs = bounded(options.recoverMs, 5_000, 10_000);
  const retryBaseMs = bounded(options.retryBaseMs, 2_000, 60_000);
  const policy = { concurrency: maxConcurrent, maxPending: maxQueued, maxWaitMs: maxQueueMs, runTimeoutMs: maxRunMs };
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      const existing = lstatSync(path);
      if (existing.isSymbolicLink() || !existing.isFile()) throw new Error("AI queue path must be a regular private database file");
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  const db = new DatabaseSync(path);
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ('users','sessions','reviews','drafts') LIMIT 1").get()) {
    db.close();
    throw new Error("AI queue requires its own database; application/account database rejected");
  }
  if (path !== ":memory:") chmodSync(path, 0o600);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_queue_policy(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ai_jobs(
      seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,kind TEXT NOT NULL CHECK(kind IN ('review','interactive')),
      site TEXT NOT NULL,owner TEXT NOT NULL,review_id TEXT,
      state TEXT NOT NULL CHECK(state IN ('queued','retrying','running','succeeded','failed')),
      created_at INTEGER NOT NULL,ready_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,attempt INTEGER NOT NULL DEFAULT 0,
      lease_token TEXT,lease_until INTEGER NOT NULL DEFAULT 0,run_deadline INTEGER NOT NULL DEFAULT 0,
      failure_pending INTEGER NOT NULL DEFAULT 0,last_error TEXT,UNIQUE(site,review_id)
    );
    CREATE INDEX IF NOT EXISTS ai_jobs_ready ON ai_jobs(state,ready_at,seq);
    CREATE INDEX IF NOT EXISTS ai_jobs_failure ON ai_jobs(site,failure_pending);
    CREATE TABLE IF NOT EXISTS ai_workers(instance_id TEXT PRIMARY KEY,site TEXT NOT NULL,last_seen INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS ai_execution_leases(token TEXT PRIMARY KEY,site TEXT NOT NULL,job_id TEXT NOT NULL,lease_until INTEGER NOT NULL);
  `);
  const serializedPolicy = JSON.stringify({ ...policy, leaseMs, retryBaseMs, maxAttempts: 2 });
  db.prepare("INSERT OR IGNORE INTO ai_queue_policy(id,value) VALUES(1,?)").run(serializedPolicy);
  if (db.prepare("SELECT value FROM ai_queue_policy WHERE id=1").get()!.value !== serializedPolicy) {
    db.close();
    throw new Error("Shared AI queue policy differs between sites; stop before accepting work");
  }
  let closed = false;
  let stopping = false;
  let ticking: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastRecovery = -Infinity;
  const instanceId = randomUUID();
  let lastWorkerHeartbeat = now();
  db.prepare("INSERT INTO ai_workers(instance_id,site,last_seen) VALUES(?,?,?)").run(instanceId, site, lastWorkerHeartbeat);
  const active = new Map<string, { id: string; controller: AbortController; promise: Promise<unknown>; token: string }>();
  const operations = new Set<Promise<unknown>>();
  const supervisors = new Set<Promise<unknown>>();
  let stopPromise: Promise<void> | undefined;
  function transaction<T>(action: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try { const result = action(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  const row = (id: string) => db.prepare("SELECT * FROM ai_jobs WHERE site=? AND review_id=?").get(site, id) as QueueRow | undefined;
  function info(saved: QueueRow | undefined): ReviewQueueInfo | undefined {
    if (!saved || !["queued", "retrying", "running"].includes(saved.state)) return undefined;
    return {
      state: saved.state as ReviewQueueInfo["state"], attempt: saved.attempt,
      position: saved.state === "running" ? 0 : Number(db.prepare("SELECT COUNT(*) AS n FROM ai_jobs WHERE kind='review' AND state IN ('queued','retrying') AND seq<=?").get(saved.seq)!.n),
    };
  }
  function owns(id: string, token: string) {
    if (closed) return false;
    return !!db.prepare("SELECT 1 FROM ai_jobs WHERE id=? AND state='running' AND lease_token=? AND lease_until>? AND run_deadline>?")
      .get(id, token, now(), now());
  }
  function reap() {
    const at = now();
    transaction(() => {
      if (at - lastWorkerHeartbeat >= Math.max(1, leaseMs / 3)) {
        db.prepare("INSERT INTO ai_workers(instance_id,site,last_seen) VALUES(?,?,?) ON CONFLICT(instance_id) DO UPDATE SET last_seen=excluded.last_seen").run(instanceId, site, at);
        lastWorkerHeartbeat = at;
      }
      db.prepare("DELETE FROM ai_execution_leases WHERE lease_until<=?").run(at);
      db.prepare("DELETE FROM ai_workers WHERE last_seen<?").run(at - leaseMs * 10);
      db.prepare("UPDATE ai_jobs SET state='failed',failure_pending=1,last_error=?,lease_token=NULL,lease_until=0 WHERE kind='review' AND state IN ('queued','retrying') AND expires_at<=?").run(timeoutMessage, at);
      const expired = db.prepare("SELECT * FROM ai_jobs WHERE state='running' AND (lease_until<=? OR run_deadline<=?)").all(at, at) as QueueRow[];
      for (const job of expired) {
        const eligible = job.kind === "review" && job.attempt < 2 && job.expires_at > at;
        const pending = Number(db.prepare("SELECT COUNT(*) AS n FROM ai_jobs WHERE kind='review' AND state IN ('queued','retrying')").get()!.n);
        const retry = eligible && pending < maxQueued;
        db.prepare("UPDATE ai_jobs SET state=?,ready_at=?,lease_token=NULL,lease_until=0,failure_pending=?,last_error=? WHERE id=? AND state='running' AND lease_token=?")
          .run(retry ? "retrying" : "failed", at + retryBaseMs * Math.max(1, job.attempt), !retry && job.kind === "review" ? 1 : 0, eligible && !retry ? retryQueueFullMessage : interruptedMessage, job.id, job.lease_token);
      }
      // Interactive work has no durable result to recover. Review tombstones remain thin and durable.
      db.prepare("DELETE FROM ai_jobs WHERE kind='interactive' AND state IN ('succeeded','failed') AND created_at<?").run(at - 3_600_000);
    });
    for (const execution of active.values()) if (!owns(execution.id, execution.token)) execution.controller.abort(new HttpError(504, timeoutMessage, "AI_JOB_TIMEOUT"));
  }
  function enqueue(owner: string, id: string, createdAt = now()) {
    if (stopping || closed) throw Object.assign(new HttpError(503, "批改服务正在恢复，请稍后提交。", "AI_QUEUE_STOPPING"), { retryAfterSeconds: 5 });
    const outcome = transaction(() => {
      const existing = row(id);
      if (existing) return { existing };
      const at = now();
      const count = Number(db.prepare("SELECT COUNT(*) AS n FROM ai_jobs WHERE kind='review' AND state IN ('queued','retrying')").get()!.n);
      const expired = createdAt + maxQueueMs <= at;
      const full = count >= maxQueued;
      db.prepare("INSERT INTO ai_jobs(id,kind,site,owner,review_id,state,created_at,ready_at,expires_at,failure_pending,last_error) VALUES(?,'review',?,?,?,?,?,?,?,?,?)")
        .run(`${site}:review:${id}`, site, owner, id, expired || full ? "failed" : "queued", createdAt, at, createdAt + maxQueueMs, expired || full ? 1 : 0, expired ? timeoutMessage : full ? busyError().message : null);
      return { existing: row(id)!, full, expired };
    });
    if (outcome.full) throw busyError();
    if (outcome.expired) throw new HttpError(504, timeoutMessage, "AI_JOB_TIMEOUT");
    const result = info(outcome.existing);
    if (!result) throw new HttpError(409, "这次批改已结束，请查看批改记录。", "AI_JOB_FINISHED");
    return result;
  }
  function claim(): QueueRow | undefined {
    if (stopping) return;
    return transaction(() => {
      const at = now();
      const running = Number(db.prepare("SELECT COUNT(*) AS n FROM ai_execution_leases WHERE lease_until>?").get(at)!.n);
      if (running >= maxConcurrent) return;
      const next = db.prepare("SELECT * FROM ai_jobs WHERE kind='review' AND state IN ('queued','retrying') AND ready_at<=? AND expires_at>? AND site IN (SELECT site FROM ai_workers WHERE last_seen>?) ORDER BY seq LIMIT 1").get(at, at, at - leaseMs) as QueueRow | undefined;
      // The process serving the other site will claim its own oldest job on its next tick.
      if (!next || next.site !== site) return;
      const token = randomUUID();
      db.prepare("INSERT INTO ai_execution_leases(token,site,job_id,lease_until) VALUES(?,?,?,?)").run(token, site, next.id, at + leaseMs);
      db.prepare("UPDATE ai_jobs SET state='running',attempt=attempt+1,lease_token=?,lease_until=?,run_deadline=? WHERE id=? AND state IN ('queued','retrying')")
        .run(token, at + leaseMs, at + maxRunMs, next.id);
      return db.prepare("SELECT * FROM ai_jobs WHERE id=?").get(next.id) as QueueRow;
    });
  }
  function track<T>(job: QueueRow, operation: (signal: AbortSignal, stillOwned: () => boolean) => Promise<T>, durable: boolean): Promise<T> {
    const controller = new AbortController();
    const token = job.lease_token!;
    const stillOwned = () => !controller.signal.aborted && owns(job.id, token);
    let timeout: ReturnType<typeof setTimeout>;
    const timeoutError = new HttpError(504, timeoutMessage, "AI_JOB_TIMEOUT");
    const abortFailure = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason ?? timeoutError), { once: true });
      timeout = setTimeout(() => controller.abort(timeoutError), maxRunMs);
      timeout.unref?.();
    });
    const heartbeat = setInterval(() => {
      if (closed) return;
      try {
        // Even a callback that ignores abort continues occupying a physical execution slot.
        // An expired physical lease is never resurrected after another process reclaimed it.
        const physical = db.prepare("UPDATE ai_execution_leases SET lease_until=? WHERE token=? AND lease_until>?").run(now() + leaseMs, token, now());
        if (!physical.changes) { controller.abort(timeoutError); return; }
        if (controller.signal.aborted) return;
        const changed = db.prepare("UPDATE ai_jobs SET lease_until=? WHERE id=? AND state='running' AND lease_token=? AND lease_until>? AND run_deadline>?")
          .run(now() + leaseMs, job.id, token, now(), now());
        if (!changed.changes) controller.abort(timeoutError);
      } catch { controller.abort(timeoutError); }
    }, Math.max(1, Math.floor(Math.min(leaseMs, maxRunMs) / 3)));
    heartbeat.unref?.();
    const operationPromise = Promise.resolve().then(() => operation(controller.signal, stillOwned));
    operations.add(operationPromise);
    void operationPromise.finally(() => {
      operations.delete(operationPromise);
      clearInterval(heartbeat);
      if (!closed) db.prepare("DELETE FROM ai_execution_leases WHERE token=?").run(token);
      active.delete(token);
    }).catch(() => {});
    const promise = Promise.race([operationPromise, abortFailure]).then(value => {
      if (!stillOwned()) throw new HttpError(503, "批改执行权已转移，当前结果未覆盖已保存记录。", "AI_JOB_CANCELLED");
      db.prepare("UPDATE ai_jobs SET state='succeeded',lease_token=NULL,lease_until=0 WHERE id=? AND state='running' AND lease_token=?").run(job.id, token);
      return value;
    }).catch(error => {
      if (!closed) {
        transaction(() => {
          const saved = db.prepare("SELECT * FROM ai_jobs WHERE id=? AND state='running' AND lease_token=?").get(job.id, token) as QueueRow | undefined;
          if (!saved) return;
          const eligible = durable && canRetry(error) && saved.attempt < 2 && saved.expires_at > now();
          const pending = Number(db.prepare("SELECT COUNT(*) AS n FROM ai_jobs WHERE kind='review' AND state IN ('queued','retrying')").get()!.n);
          const retry = eligible && pending < maxQueued;
          const providerDelay = error instanceof HttpError && typeof error.retryAfterSeconds === "number" && Number.isFinite(error.retryAfterSeconds)
            ? Math.max(0, Math.min(60_000, error.retryAfterSeconds * 1000)) : 0;
          const failure = eligible && !retry ? retryQueueFullMessage : durable && canRetry(error) && !retry
            ? "批改服务持续繁忙或超时，本次未能完成。作答已保留，请稍后重试。" : reviewFailureMessage(error);
          db.prepare("UPDATE ai_jobs SET state=?,ready_at=?,lease_token=NULL,lease_until=0,failure_pending=?,last_error=? WHERE id=? AND state='running' AND lease_token=?")
            .run(retry ? "retrying" : "failed", now() + Math.max(retryBaseMs * Math.max(1, saved.attempt), providerDelay), !retry && durable ? 1 : 0, failure, job.id, token);
        });
      }
      throw error;
    }).finally(() => {
      clearTimeout(timeout);
    });
    supervisors.add(promise);
    void promise.finally(() => supervisors.delete(promise)).catch(() => {});
    active.set(token, { id: job.id, controller, promise, token });
    return promise;
  }
  const jobs: AiJobs = {
    policy,
    enqueueReview: async (owner, id) => enqueue(owner, id),
    reviewInfo: id => closed ? undefined : info(row(id)),
    isManaged: id => !closed && !!row(id),
    async runInteractive<T>(owner: string, operation: (signal: AbortSignal, stillOwned: () => boolean) => Promise<T>, externalSignal?: AbortSignal): Promise<T> {
      if (externalSignal?.aborted) throw externalSignal.reason;
      if (stopping || closed) throw busyError();
      reap();
      const interactive = transaction(() => {
        const at = now();
        const running = Number(db.prepare("SELECT COUNT(*) AS n FROM ai_execution_leases WHERE lease_until>?").get(at)!.n);
        const pendingReview = !!db.prepare("SELECT 1 FROM ai_jobs WHERE kind='review' AND state IN ('queued','retrying') AND ready_at<=? AND site IN (SELECT site FROM ai_workers WHERE last_seen>?) LIMIT 1").get(at, at - leaseMs);
        if (running >= maxConcurrent || pendingReview) return;
        const id = `${site}:interactive:${randomUUID()}`;
        const token = randomUUID();
        db.prepare("INSERT INTO ai_execution_leases(token,site,job_id,lease_until) VALUES(?,?,?,?)").run(token, site, id, at + leaseMs);
        db.prepare("INSERT INTO ai_jobs(id,kind,site,owner,state,created_at,ready_at,expires_at,attempt,lease_token,lease_until,run_deadline) VALUES(?,'interactive',?,?,'running',?,?,?,?,?,?,?)")
          .run(id, site, owner, at, at, at + maxRunMs, 1, token, at + leaseMs, at + maxRunMs);
        return db.prepare("SELECT * FROM ai_jobs WHERE id=?").get(id) as QueueRow;
      });
      if (!interactive) throw busyError();
      const execution = track(interactive, operation, false);
      const onAbort = () => active.get(interactive.lease_token!)?.controller.abort(externalSignal?.reason);
      externalSignal?.addEventListener("abort", onAbort, { once: true });
      try { return await execution; }
      finally { externalSignal?.removeEventListener("abort", onAbort); }
    },
  };
  async function doTick() {
    if (stopping || closed) return;
    reap();
    if (now() - lastRecovery >= recoverMs) {
      lastRecovery = now();
      const missing = await recoverReviews();
      for (const pending of missing) {
        if (stopping) return;
        if (row(pending.id)) continue;
        const original = pending.createdAt ? Date.parse(pending.createdAt) : now();
        try { enqueue(pending.owner, pending.id, Number.isFinite(original) ? original : now()); }
        catch (error) { if (!(error instanceof HttpError)) throw error; }
      }
    }
    const failures = db.prepare("SELECT * FROM ai_jobs WHERE site=? AND kind='review' AND state='failed' AND failure_pending=1 ORDER BY seq LIMIT 30").all(site) as QueueRow[];
    for (const failed of failures) {
      if (stopping) return;
      try {
        await failReview(failed.owner, failed.review_id!, failed.last_error ?? interruptedMessage);
        db.prepare("UPDATE ai_jobs SET failure_pending=0 WHERE id=? AND state='failed'").run(failed.id);
      } catch { /* Retain the marker; a later tick repairs the site record. */ }
    }
    while (!stopping) {
      const next = claim();
      if (!next) break;
      void track(next, (signal, stillOwned) => executeReview(next.owner, next.review_id!, signal, stillOwned), true).catch(() => {});
    }
  }
  function tick(): Promise<void> {
    if (ticking) return ticking;
    ticking = doTick().finally(() => { ticking = undefined; });
    return ticking;
  }
  function snapshot(): AiJobSnapshot {
    if (closed) throw new Error("AI queue is closed");
    const counts = Object.fromEntries(db.prepare("SELECT state,COUNT(*) AS n FROM ai_jobs GROUP BY state").all().map(record => [String(record.state), Number(record.n)]));
    const oldest = db.prepare("SELECT MIN(created_at) AS at FROM ai_jobs WHERE kind='review' AND state IN ('queued','retrying')").get()!.at;
    const physical = Number(db.prepare("SELECT COUNT(*) AS n FROM ai_execution_leases WHERE lease_until>?").get(now())!.n);
    return { running: physical, queued: counts.queued ?? 0, retrying: counts.retrying ?? 0, failed: counts.failed ?? 0, completed: counts.succeeded ?? 0, concurrency: maxConcurrent, maxPending: maxQueued, oldestQueuedMs: oldest === null ? 0 : Math.max(0, now() - Number(oldest)) };
  }
  return {
    jobs, tick, snapshot,
    start() {
      if (timer || stopping || closed) return;
      timer = setInterval(() => { void tick().catch(() => { console.warn("AI queue scheduler will retry."); }); }, pollMs);
      timer.unref?.();
      void tick().catch(() => { console.warn("AI queue recovery will retry."); });
    },
    stop(): Promise<void> {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        if (closed) return;
        stopping = true;
        if (timer) clearInterval(timer);
        db.prepare("DELETE FROM ai_workers WHERE instance_id=?").run(instanceId);
        await ticking;
        // Drain current work. The per-job deadline still aborts stuck requests; queued work remains durable.
        await Promise.allSettled([...supervisors]);
        // A callback must observe abort. Never close the DB while its final guarded cleanup is still running.
        await Promise.allSettled([...operations]);
        db.close(); closed = true;
      })();
      return stopPromise;
    },
  };
}
