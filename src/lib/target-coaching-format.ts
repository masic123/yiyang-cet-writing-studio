import type { TargetCoaching } from "./target-coaching-types";
export const coachingScoreLabel = (value: number | null, scale: "cet" | "ielts") => value === null ? "尚未完整评分" : scale === "cet" ? `${value} / 15` : `${value.toFixed(1)} 分`;
export function targetCoachingText(coaching?: TargetCoaching) {
  if (!coaching) return "";
  const meta = `## 目标提升（学习建议）\n本次参考分：${coachingScoreLabel(coaching.currentScore, coaching.scale)}\n学习目标：${coachingScoreLabel(coaching.target, coaching.scale)}\n目标用于安排学习，不改变本次估分；可选表达不等同于错误，也不保证加分。`;
  if (coaching.status === "unavailable") return `${meta}\n${coaching.message}`;
  const c = coaching.content;
  return [meta, c.summary, "### 优先练习\n" + c.priorities.map(p => `${p.focus}\n${p.reason}\n行动：${p.action}`).join("\n\n"), "### 值得保留\n" + c.preserve.map(p => `${p.quote}\n${p.reason}`).join("\n\n"), c.rewrites.length ? "### 可选表达练习\n" + c.rewrites.map(r => `原表达：${r.original}\n可选表达：${r.replacement}\n${r.explanation}\n适用边界：${r.boundary}`).join("\n\n") : "", "### 可迁移词块与句型\n" + c.chunks.map(c => `${c.pattern}\n${c.meaning}\n例句：${c.example}\n适用：${c.whenToUse}\n注意：${c.caution}`).join("\n\n"), `### 自拟微练习\n${c.practice.instruction}\n${c.practice.prompt}\n参考答案（不唯一）：${c.practice.referenceAnswer}\n${c.practice.explanation}`].filter(Boolean).join("\n\n");
}
