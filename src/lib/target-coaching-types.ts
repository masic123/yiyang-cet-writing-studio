export const TARGET_COACHING_VERSION = "target-coaching-v1" as const;
type CoachingMeta = {
  version: typeof TARGET_COACHING_VERSION;
  scale: "cet" | "ielts";
  target: number | null;
  currentScore: number | null;
  contextFingerprint?: string;
};
export type TargetCoachingContent = {
  summary: string;
  priorities: { focus: string; reason: string; action: string }[];
  preserve: { quote: string; reason: string }[];
  rewrites: { original: string; replacement: string; explanation: string; boundary: string }[];
  chunks: { pattern: string; meaning: string; example: string; whenToUse: string; caution: string }[];
  practice: { instruction: string; prompt: string; referenceAnswer: string; explanation: string };
};
export type TargetCoaching = CoachingMeta & (
  | { status: "ready"; content: TargetCoachingContent }
  | { status: "unavailable"; message: string }
);
