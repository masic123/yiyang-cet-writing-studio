"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { User } from "./types";

type Auth = { user: User | null; invitationRequired: boolean };
export function useAuthSession(api: <T>(url: string, options?: RequestInit) => Promise<T>, expiredEvent: string) {
  const [user, assignUser] = useState<User | null>(null);
  const [authLoaded, setAuthLoaded] = useState(false);
  const [authError, setAuthError] = useState("");
  const [invitation, setInvitation] = useState(false);
  const revision = useRef(0);
  const userRef = useRef(user);
  const restore = useRef<() => void>(() => {});
  const setUser = useCallback((value: User | null) => {
    revision.current++;
    userRef.current = value;
    assignUser(value);
    setAuthLoaded(true);
    setAuthError("");
  }, []);
  useEffect(() => {
    let active = true, failures = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let pending: AbortController | null = null;
    const refresh = async () => {
      if (!active || pending) return;
      clearTimeout(retry);
      const version = revision.current;
      const controller = new AbortController();
      pending = controller;
      const timeout = setTimeout(() => controller.abort(), 12000);
      try {
        const response = await api<Auth>("/api/auth", { signal: controller.signal });
        if (!active || version !== revision.current) return;
        if (response.user !== null && typeof response.user?.id !== "string") throw new Error("Invalid session response");
        const expired = userRef.current && !response.user;
        userRef.current = response.user;
        assignUser(response.user);
        setInvitation(response.invitationRequired);
        setAuthError("");
        setAuthLoaded(true);
        failures = 0;
        if (expired) window.dispatchEvent(new Event(expiredEvent));
      } catch {
        if (!active || version !== revision.current) return;
        // A temporary connection failure must never erase an authenticated user.
        setAuthLoaded(true);
        setAuthError("暂时无法连接账号服务，正在自动重连。");
        retry = setTimeout(refresh, Math.min(1500 * 3 ** failures++, 60000));
      } finally {
        clearTimeout(timeout);
        if (pending === controller) pending = null;
      }
    };
    restore.current = () => { void refresh(); };
    const resume = () => { if (document.visibilityState !== "hidden") void refresh(); };
    window.addEventListener("online", resume);
    window.addEventListener("focus", resume);
    window.addEventListener("pageshow", resume);
    document.addEventListener("visibilitychange", resume);
    const interval = setInterval(resume, 5 * 60 * 1000);
    void refresh();
    return () => {
      active = false;
      clearTimeout(retry);
      clearInterval(interval);
      pending?.abort();
      window.removeEventListener("online", resume);
      window.removeEventListener("focus", resume);
      window.removeEventListener("pageshow", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [api, expiredEvent]);
  const reconnect = useCallback(() => restore.current(), []);
  return { user, setUser, authLoaded, authError, invitation, reconnect };
}
