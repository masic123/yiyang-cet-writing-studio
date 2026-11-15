import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { HttpError } from "../src/lib/http";
import type { Env } from "./types";

/** Every provider request remains cancellable, including multi-stage reviews. */
export function abortableFetch(signal: AbortSignal, stillOwned: () => boolean = () => true, requestFetch: typeof fetch = fetch): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    if (signal.aborted || !stillOwned()) throw new HttpError(503, "批改执行已中止，作答已保留。", "AI_JOB_CANCELLED");
    const inherited = init?.signal || (input instanceof Request ? input.signal : undefined);
    return requestFetch(input, { ...init, signal: inherited ? AbortSignal.any([signal, inherited]) : signal });
  }) as typeof fetch;
}

export function runInteractive<T>(env: Env, owner: string, externalSignal: AbortSignal,
  operation: (signal: AbortSignal, requestFetch: typeof fetch, stillOwned: () => boolean) => Promise<T>): Promise<T> {
  if (env.AI_JOBS) return env.AI_JOBS.runInteractive(owner, (signal, stillOwned) => operation(signal, abortableFetch(signal, stillOwned), () => !signal.aborted && stillOwned()), externalSignal);
  return operation(externalSignal, abortableFetch(externalSignal), () => !externalSignal.aborted);
}

/** Recheck the lease at the actual SQLite call, after any earlier asynchronous work. */
export function fencedDatabase(database: D1Database, guard: () => boolean): D1Database {
  const check = () => { if (!guard()) throw new HttpError(503, "批改执行权已转移，当前结果未覆盖已保存记录。", "AI_JOB_CANCELLED"); };
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (key === "bind") return (...args: unknown[]) => wrap(Reflect.apply(value, target, args));
      if (["first", "all", "run", "raw"].includes(String(key))) return (...args: unknown[]) => { check(); return Reflect.apply(value, target, args); };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(database, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (key === "prepare") return (query: string) => wrap(target.prepare(query));
      if (key === "batch" || key === "exec") return (...args: unknown[]) => { check(); return Reflect.apply(value, target, args); };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
