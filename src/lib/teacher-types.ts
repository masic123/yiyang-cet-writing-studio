import type { EssayInput } from "./types";

export type TeacherSource = {
  id: number;
  title: string;
  url: string | null;
  kind: "official" | "advice" | "sample" | "question" | "scope" | "context" | "history";
  note: string;
  reviewId?: string;
  draftId?: string;
};
export type TeacherHistoryEvidence = Omit<TeacherSource, "id"> & { text: string };
export type TeacherReply = {
  answer: string;
  sources: TeacherSource[];
  model: string;
};
export type TeacherTurn = {
  role: "user" | "assistant";
  content: string;
};
export type TeacherContext = Pick<EssayInput, "questionId" | "customQuestion">;
