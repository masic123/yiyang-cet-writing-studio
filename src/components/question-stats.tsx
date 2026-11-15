"use client";
import { useEffect, useState } from "react";
import type { QuestionStats, QuestionStatsData } from "@/lib/question-stats-types";

export function useQuestionStats() {
  const [data, setData] = useState<QuestionStatsData | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    let request: AbortController | undefined;
    async function load() {
      request?.abort();
      const controller = new AbortController(); request = controller;
      try {
        const response = await fetch("/api/question-stats", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Question statistics unavailable");
        const value = await response.json() as QuestionStatsData;
        if (active && !controller.signal.aborted) { setData(value); setError(false); }
      } catch {
        if (active && !controller.signal.aborted) setError(true);
      }
    }
    void load();
    const visible = () => { if (!document.hidden) void load(); };
    const timer = window.setInterval(visible, 60_000);
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    return () => { active = false; request?.abort(); window.clearInterval(timer); window.removeEventListener("focus", visible); document.removeEventListener("visibilitychange", visible); };
  }, [attempt]);
  return { data, error, retry: () => setAttempt(value => value + 1) };
}

export function QuestionStatsLine({ stat, loaded, error, maxScore }: { stat?: QuestionStats; loaded: boolean; error: boolean; maxScore: number }) {
  return <span className="question-card-stats" title="人数去重，均分取每人首次得分">
    {!loaded ? <span>{error ? "统计暂不可用" : "正在加载作答统计…"}</span> : <>
      <span><b>{stat?.participants || 0}</b> 人写过</span>
      <span>{stat ? <>首次均分 <b>{stat.averageScore.toFixed(1)}</b><small> / {maxScore}</small></> : "暂无均分"}</span>
    </>}
  </span>;
}
