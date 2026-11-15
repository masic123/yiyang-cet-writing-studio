"use client";
import { useEffect, useRef, useState } from "react";
import { readStoredTarget, rememberTarget, targetDefault, validTarget } from "./target-preference";
import { createTargetPreferenceSync, type TargetPreference, type TargetSyncState } from "./target-preference-sync";

type Api = <T>(url: string, options?: RequestInit) => Promise<T>;
async function timedRequest<T>(signal: AbortSignal, request: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  const timeout = setTimeout(abort, 12000);
  try { return await request(controller.signal); }
  finally { clearTimeout(timeout); signal.removeEventListener("abort", abort); }
}
export function useTargetPreference(ownerId: string | null, authLoaded: boolean, api: Api,
  apply: (target: number, owner: string | null) => void) {
  const live = useRef({ ownerId, apply });
  live.current = { ownerId, apply };
  const [state, setState] = useState<TargetSyncState>({ ownerId: undefined, target: targetDefault, status: "loading" });
  const sync = useRef<ReturnType<typeof createTargetPreferenceSync> | null>(null);
  if (!sync.current) sync.current = createTargetPreferenceSync({
    defaultTarget: targetDefault, valid: validTarget,
    readLocal: readStoredTarget, writeLocal: rememberTarget,
    read: async (owner, signal) => {
      const result = await timedRequest(signal, requestSignal => api<TargetPreference>("/api/preferences/target", { signal: requestSignal }));
      if (result.ownerId !== owner) throw new Error("Account changed");
      return result;
    },
    write: (owner, target, expectedVersion, signal) => timedRequest(signal, requestSignal => api<TargetPreference>("/api/preferences/target", {
      method: "PUT", body: JSON.stringify({ ownerId: owner, target, expectedVersion }),
      signal: requestSignal, keepalive: true,
    })),
    changed: setState,
    apply: (target, owner) => { if (owner === live.current.ownerId) live.current.apply(target, owner); },
  });
  useEffect(() => {
    if (!authLoaded) return;
    const client = sync.current!;
    client.setOwner(ownerId);
    const refresh = () => { if (document.visibilityState !== "hidden") void client.refresh(); };
    window.addEventListener("online", refresh);
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", refresh);
    document.addEventListener("visibilitychange", refresh);
    const interval = setInterval(refresh, 5 * 60 * 1000);
    return () => {
      client.stop();
      clearInterval(interval);
      window.removeEventListener("online", refresh);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pageshow", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [ownerId, authLoaded]);
  const status = authLoaded && state.ownerId === ownerId ? state.status : "loading";
  const message = {
    guest: "未登录，仅当前设备使用",
    loading: "正在同步账号目标…",
    default: "选择目标后随账号保存",
    saving: "正在保存到账号…",
    saved: "已保存到账号",
    error: "目标分未同步，请重试保存",
  }[status];
  return {
    status, message,
    current: () => sync.current!.valueFor(live.current.ownerId),
    choose: (target: number) => { if (authLoaded) { sync.current!.setOwner(live.current.ownerId); sync.current!.choose(target); } },
    retry: () => { void sync.current!.retry(); },
  };
}
