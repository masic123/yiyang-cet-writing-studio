"use client";
import { useEffect, useId, useRef, useState } from "react";
import { ArrowClockwise, CaretDown, CaretUp, Trophy, X } from "@phosphor-icons/react";
import type { LeaderboardData, LeaderboardEntry } from "@/lib/leaderboard-types";

export default function Leaderboard({ user, refreshKey, placement = "mobile" }: { user: { id: string } | null; refreshKey: string; placement?: "sidebar" | "mobile" }) {
  const sidebar = placement === "sidebar";
  const [enabled, setEnabled] = useState(false);
  const id = useId();
  const [period, setPeriod] = useState<"daily" | "total">("daily");
  const [expanded, setExpanded] = useState(false);
  const [data, setData] = useState<{ owner: string; value: LeaderboardData } | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const request = useRef<AbortController | null>(null);
  const container = useRef<HTMLElement | null>(null);
  const detailsTrigger = useRef<HTMLButtonElement | null>(null);
  const mobileTrigger = useRef<HTMLButtonElement | null>(null);
  const returnFocus = () => (window.matchMedia("(max-width: 767px)").matches ? mobileTrigger : detailsTrigger).current?.focus();
  const owner = user?.id || "guest";
  const current = data?.owner === owner ? data.value : null;
  useEffect(() => {
    const media = window.matchMedia("(min-width: 768px)");
    const sync = () => setEnabled(sidebar ? media.matches : !media.matches);
    sync(); media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [sidebar]);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    async function load() {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      try {
        const response = await fetch("/api/leaderboard", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Leaderboard unavailable");
        const value = await response.json() as LeaderboardData;
        if (active && !controller.signal.aborted) { setData({ owner, value }); setError(false); }
      } catch {
        if (active && !controller.signal.aborted) setError(true);
      } finally {
        if (active && !controller.signal.aborted) setLoading(false);
      }
    }
    setLoading(true); setError(false);
    void load();
    const visible = () => { if (!document.hidden) void load(); };
    const interval = window.setInterval(visible, 60_000);
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    return () => { active = false; request.current?.abort(); window.clearInterval(interval); window.removeEventListener("focus", visible); document.removeEventListener("visibilitychange", visible); };
  }, [owner, refreshKey, attempt, enabled]);
  useEffect(() => {
    if (!expanded) return;
    const outside = (event: MouseEvent) => { if (event.target instanceof Node && !container.current?.contains(event.target)) setExpanded(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setExpanded(false); returnFocus(); } };
    document.addEventListener("click", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("click", outside); document.removeEventListener("keydown", escape); };
  }, [expanded]);
  const entries = current?.[period] || [];
  const mine = current?.mine?.[period];
  const points = (value: number) => Number.isInteger(value) ? String(value) : value.toFixed(1);
  function participant(entry: LeaderboardEntry) {
    return <><span className="leaderboard-name">{entry.name}</span>{entry.isMe && <span className="leaderboard-me">我</span>}</>;
  }
  return (
    <section className={`leaderboard leaderboard-${placement}`} ref={container} aria-label="刷题排行榜">
      {!sidebar && <button type="button" ref={mobileTrigger} className="leaderboard-mobile-trigger" aria-expanded={expanded} aria-controls={`${id}-more`} onClick={() => setExpanded(value => !value)}><Trophy size={17} aria-hidden="true" />刷题榜<CaretDown size={12} aria-hidden="true" /></button>}
      <div className="leaderboard-heading">
        <div className="leaderboard-label"><Trophy size={17} weight="duotone" aria-hidden="true" /><h2>刷题榜</h2></div>
        <div className="leaderboard-tabs" role="tablist" aria-label="排行榜周期">
          {([["daily", "每日榜"], ["total", "总榜"]] as const).map(([value, label]) => <button type="button" key={value} id={`${id}-${value}`} role="tab" aria-selected={period === value} aria-controls={`${id}-panel`} tabIndex={period === value ? 0 : -1}
            onClick={() => { setPeriod(value); setExpanded(false); }} onKeyDown={event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = event.key === "Home" ? "daily" : event.key === "End" ? "total" : period === "daily" ? "total" : "daily"; setPeriod(next); setExpanded(false); document.getElementById(`${id}-${next}`)?.focus(); } }}>{label}</button>)}
        </div>
      </div>
      <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${period}`} aria-busy={loading && !current}>
        <div className="leaderboard-scroll" tabIndex={sidebar ? 0 : undefined} role={sidebar ? "region" : undefined} aria-label={sidebar ? `${period === "daily" ? "每日榜" : "总榜"}名单` : undefined}>
        {loading && !current ? <div className="leaderboard-loading" role="status">正在载入排行榜…</div> : error && !current ? <div className="leaderboard-empty" role="status">排行榜暂时未能载入。<button type="button" className="text-button" onClick={() => setAttempt(n => n + 1)}><ArrowClockwise size={15} />重试</button></div> : entries.length ? <>
          <ol className="leaderboard-podium">
            {(sidebar ? entries : entries.slice(0, 3)).map((entry, index) => <li key={index} className={entry.isMe ? "is-me" : ""} title={`${entry.attempts} 次有效作答，${points(entry.points)} 积分`}><span className="leaderboard-rank" aria-label={`第${entry.rank}名`}>{entry.rank}</span><div className="leaderboard-person">{participant(entry)}</div><strong className="leaderboard-points">{points(entry.points)}<small>分</small></strong></li>)}
          </ol>
        </> : <div className="leaderboard-empty">{period === "daily" ? "今日还没有有效作答" : "完成批改，积累第一笔积分"}</div>}
        </div>
        {(mine || !sidebar) && <div className="leaderboard-footer">
          {mine && <span className="leaderboard-own" aria-label="我的排行">我：<b>{points(mine.points)}</b> 分{mine.rank !== null ? ` · 第 ${mine.rank} 名` : " · 暂未上榜"}</span>}
          {!sidebar && <button type="button" ref={detailsTrigger} className="leaderboard-expand text-button" aria-expanded={expanded} aria-controls={`${id}-more`} onClick={() => setExpanded(value => !value)}>完整榜单{expanded ? <CaretUp size={12} /> : <CaretDown size={12} />}</button>}
        </div>}
        {error && current && <p className="leaderboard-stale" role="status">暂时未能刷新<button type="button" className="text-button" onClick={() => setAttempt(n => n + 1)}>重试</button></p>}
      </div>
      {!sidebar && expanded && <div className="leaderboard-details" id={`${id}-more`} role="region" aria-label="完整刷题榜单">
        <div className="leaderboard-details-heading"><strong>{period === "daily" ? "每日排行榜" : "累计总榜"}</strong><button type="button" className="icon-button" aria-label="关闭完整榜单" onClick={() => { setExpanded(false); returnFocus(); }}><X size={16} /></button></div>
        <div className="leaderboard-mobile-period" role="group" aria-label="切换榜单">{([['daily','每日榜'],['total','总榜']] as const).map(([value,label]) => <button type="button" key={value} aria-pressed={period === value} onClick={() => setPeriod(value)}>{label}</button>)}</div>
        <p className="leaderboard-caption">{period === "daily" ? `${current?.date || "今日"} · 北京时间` : "累计有效作答得分"}{current ? ` · 共 ${entries.length} 人` : ""} · 积分相同并列排名</p>
        {loading && !current ? <p className="leaderboard-details-empty" role="status">正在载入排行榜…</p> : error && !current ? <p className="leaderboard-details-empty" role="status">暂时未能载入。<button type="button" className="text-button" onClick={() => setAttempt(n => n + 1)}>重试</button></p> : !entries.length && <p className="leaderboard-details-empty">{period === "daily" ? "今日还没有有效作答" : "完成批改，积累第一笔积分"}</p>}
        {entries.length > 0 && <div className="leaderboard-table-wrap"><table className="leaderboard-table"><thead><tr><th scope="col">名次</th><th scope="col">昵称</th><th scope="col">有效作答</th><th scope="col">积分</th></tr></thead><tbody>{entries.map((entry, index) => <tr key={index} className={entry.isMe ? "is-me" : ""}><td>{entry.rank}</td><td>{participant(entry)}</td><td>{entry.attempts} 次</td><td>{points(entry.points)}</td></tr>)}</tbody></table></div>}
        <p className="leaderboard-rules">有效批改按得分累计，同题相同作答只计一次；句子默写首次通过得 1 分，每句不重复计分。未给总分的批改不计入。每日榜按北京时间零点切换，每日榜与总榜均展示全部参与排名的用户。</p>
      </div>}
    </section>
  );
}
