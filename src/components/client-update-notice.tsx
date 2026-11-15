"use client";
import { useEffect, useState } from "react";
import { ArrowDown, ArrowClockwise, X } from "@phosphor-icons/react";
import { clientUpdate, compareClientVersions, installedClient, nativeUpdateVersion, type ClientRelease } from "@/lib/client-update";

export default function ClientUpdateNotice() {
  const [update, setUpdate] = useState<ClientRelease | null>(null);
  useEffect(() => {
    const client = installedClient(navigator.userAgent);
    // This bridge upgrades clients shipped before native update checks existed.
    if (!client || compareClientVersions(client.version, nativeUpdateVersion) !== -1) return;
    let alive = true, checking = false;
    const deferred = (version: string) => {
      try { const until = Number(localStorage.getItem(`cet:defer-client-update:${client.platform}:${version}`)); return until > Date.now() && until <= Date.now() + 86400000; } catch { return false; }
    };
    const refresh = async () => {
      if (checking || document.visibilityState === "hidden") return;
      checking = true;
      const controller = new AbortController(), timeout = window.setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch("/downloads/manifest.json", { cache: "no-store", signal: controller.signal });
        if (!response.ok) return;
        const release = clientUpdate(client, await response.json());
        if (alive) setUpdate(release && !deferred(release.version) ? release : null);
      } catch { /* Checking for updates must never interrupt a practice session. */ }
      finally { window.clearTimeout(timeout); checking = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 300000);
    const resume = () => void refresh();
    window.addEventListener("focus", resume); document.addEventListener("visibilitychange", resume);
    return () => { alive = false; window.clearInterval(timer); window.removeEventListener("focus", resume); document.removeEventListener("visibilitychange", resume); };
  }, []);
  if (!update) return null;
  return <aside className="client-update-notice" role="status" aria-label="客户端更新">
    <ArrowClockwise size={18} /><span>译洋有新版本 <b>v{update.version}</b></span>
    <a href={`/downloads/${update.file}`} download>下载更新<ArrowDown size={15} /></a>
    <button type="button" className="icon-button" aria-label="稍后提醒更新" title="24 小时后再提醒" onClick={() => {
      const client = installedClient(navigator.userAgent);
      if (client) try { localStorage.setItem(`cet:defer-client-update:${client.platform}:${update.version}`, String(Date.now() + 86400000)); } catch {}
      setUpdate(null);
    }}><X size={17} /></button>
  </aside>;
}
