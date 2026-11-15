import { z } from "zod";

const text = (max: number) => z.string().trim().min(1).max(max);
/** This schema belongs only to teaching, never to an assessor response. */
export const targetCoachingContentSchema = z.object({
  summary: text(1000),
  priorities: z.array(z.object({ focus: text(140), reason: text(500), action: text(600) }).strict()).min(1).max(3),
  preserve: z.array(z.object({ quote: text(1000), reason: text(500) }).strict()).min(1).max(3),
  rewrites: z.array(z.object({ original: text(1400), replacement: text(1800), explanation: text(600), boundary: text(600) }).strict()).max(4),
  chunks: z.array(z.object({ pattern: text(300), meaning: text(400), example: text(1000), whenToUse: text(500), caution: text(500) }).strict()).length(2),
  practice: z.object({ instruction: text(700), prompt: text(1600), referenceAnswer: text(2200), explanation: text(700) }).strict(),
}).strict();
const meta = { version: z.literal("target-coaching-v1"), scale: z.enum(["cet", "ielts"]), target: z.number().finite().nullable(), currentScore: z.number().finite().nullable(), contextFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional() };
export const targetCoachingSchema = z.discriminatedUnion("status", [
  z.object({ ...meta, status: z.literal("ready"), content: targetCoachingContentSchema }).strict(),
  z.object({ ...meta, status: z.literal("unavailable"), message: text(500) }).strict(),
]);
