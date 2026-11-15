import data from "../../data/culture-translation.json";
import type { ExamLevel, Question } from "./types";

export type CultureTranslation = {
  id: number;
  examType: ExamLevel;
  topic: string;
  category: string;
  sourceText: string;
  referenceTranslation: string;
  sentences: [string, string][];
  sourcePages: number[];
  sourceChapter: string;
};

// The reference answer stays separate from the question API and grading input.
export const cultureTranslations: CultureTranslation[] = data.map(record => ({
  ...record,
  examType: record.examType as ExamLevel,
  sentences: record.sentences.map(([chinese, english]): [string, string] => [chinese, english]),
}));
export const cultureTranslationById = new Map(cultureTranslations.map(record => [record.id, record]));
export const cultureQuestions: Question[] = cultureTranslations.map((record, index) => ({
  id: record.id,
  name: `中国文化补充翻译 · ${record.topic}（${record.examType === "CET4" ? "四级" : "六级"}）`,
  examType: record.examType,
  task: "translation",
  session: "",
  set: index + 1,
  category: record.category,
  topic: record.topic,
  stem: "Directions: For this part, you are allowed 30 minutes to translate a passage from Chinese into English. You should write your answer on Answer Sheet 2.",
  sourceText: record.sourceText,
  wordLimit: null,
  timeLimit: 30,
  sourceType: "original_adaptation",
  sourceUrl: "",
  images: [],
  needsVisual: false,
  transcriptionStatus: "original_adaptation",
}));
