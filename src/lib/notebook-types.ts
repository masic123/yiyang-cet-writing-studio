import type { ExamLevel, Feedback, Task } from "./types";

export type MistakeKind = Feedback["corrections"][number]["kind"];
export type MistakeStatus = "active" | "mastered" | "ignored";
export type MistakeDetail = {
  title: string;
  kind: MistakeKind;
  wrong: string;
  right: string;
  pattern: string;
  explanation: string;
};
export type MistakeEvidence = {
  reviewId: string;
  createdAt: string;
  question: string;
  examType: ExamLevel;
  task: Task;
  original: string;
  replacement: string;
  reason: string;
  source?: string;
};
export type NotebookItem = MistakeDetail & {
  id: string;
  status: MistakeStatus;
  occurrenceCount: number;
  updatedAt: string;
  occurrences: MistakeEvidence[];
};
export type PracticeTarget = MistakeDetail & { id: string };
export type PracticeContent = {
  title: string;
  instruction: string;
  prompt: string;
  referenceAnswer: string;
  coverage: { itemId: string; expression: string; explanation: string }[];
};
export type PracticeFeedback = {
  summary: string;
  revisedAnswer: string;
  results: {
    itemId: string;
    status: "secure" | "retry" | "missing";
    quote: string;
    correction: string;
    explanation: string;
  }[];
};
export type PracticeAttempt = {
  id: string;
  exerciseId: string;
  answer: string;
  status: "processing" | "completed" | "failed";
  feedback: PracticeFeedback | null;
  error: string | null;
  createdAt: string;
};
export type NotebookExercise = {
  id: string;
  task: Task;
  examType: ExamLevel;
  status: "processing" | "completed" | "failed";
  targets: PracticeTarget[];
  content: Omit<PracticeContent, "referenceAnswer" | "coverage"> | null;
  solution: Pick<PracticeContent, "referenceAnswer" | "coverage"> | null;
  revealed: boolean;
  error: string | null;
  createdAt: string;
  attempts: PracticeAttempt[];
};
export type NotebookData = {
  items: NotebookItem[];
  exercises: NotebookExercise[];
  reviewedCount: number;
};
export const mistakeLabels: Record<MistakeKind, string> = {
  grammar: "语法", vocabulary: "词汇与搭配", clarity: "表达", logic: "逻辑", accuracy: "原意传达",
};
