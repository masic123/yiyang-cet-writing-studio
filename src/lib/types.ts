export type ExamLevel = "CET4" | "CET6";
export type Task = "writing" | "translation";
export type Question = {
  id: number;
  name: string;
  examType: ExamLevel;
  task: Task;
  session: string;
  set: number;
  category: string;
  topic: string;
  stem: string;
  sourceText: string;
  wordLimit: { min: number; max: number } | null;
  timeLimit: number;
  sourceType: "third_party_compilation" | "original_adaptation" | "custom";
  sourceUrl: string;
  images: string[];
  needsVisual: boolean;
  transcriptionStatus: string;
};
export type User = { id: string; name: string; email: string };
export type WritingOutline = {
  analysis: string;
  position: string;
  paragraphs: { id: string; point: string; support: string }[];
  ending: string;
};
export type EssayInput = {
  questionId: number | null;
  customQuestion?: {
    stem: string;
    sourceText: string;
    task: Task;
    examType: ExamLevel;
    needsVisual: boolean;
    visualDescription?: string;
    wordMin?: number;
    wordMax?: number;
  };
  essay: string;
  outline?: WritingOutline;
  targetScore: number;
  title: string;
};
export type Draft = {
  id: string;
  input: EssayInput;
  version: number;
  updatedAt: string;
  wordCount: number;
};
export type MethodRule = {
  id: string;
  title: string;
  summary: string;
  detail: string;
  task: Task | "all";
  source: {
    title: string;
    section: string;
    page: number;
    url: string;
    kind: "official_summary" | "practice_advice";
  };
};
export type ExpressionSuggestion = {
  kind: "vocabulary" | "phrase" | "sentence";
  original: string;
  replacement: string;
  explanation: string;
  example: string;
};
export type Feedback = {
  targetCoaching?: import("./target-coaching-types").TargetCoaching;
  assessmentVersion?: string;
  assessmentFingerprint?: string;
  revisionAssessment?: {
    status: "checked" | "needs_work" | "unverified";
    holisticScore: number | null;
    bandRange: string | null;
    summary: string;
    remainingIssues: string[];
    assessmentFingerprint?: string;
    scoringEvidence?: Feedback["scoringEvidence"];
    strengths?: string[];
    scoreReason?: string;
  };
  scoringEvidence?: {
    taskChecks: { requirement: string; status: "met" | "partial" | "missing"; evidence: string[]; explanation: string }[];
    findings: { kind: string; severity: "minor" | "major"; original: string; replacement: string; requirement: string; reason: string }[];
  };
  summary: string;
  holisticScore: number | null;
  bandRange: string | null;
  scoreReason: string;
  assessmentScope: "full" | "language_only";
  diagnostics: {
    area: string;
    status: "secure" | "developing" | "priority";
    evidence: string;
    advice: string;
  }[];
  strengths: string[];
  priorities: { title: string; reason: string; action: string }[];
  methodChecks: {
    ruleId: string;
    status: "met" | "partial" | "missing" | "not_applicable";
    evidence: string;
    advice: string;
  }[];
  paragraphs: {
    index: number;
    role: string;
    feedback: string;
    suggestion: string;
  }[];
  corrections: {
    original: string;
    replacement: string;
    reason: string;
    kind: "grammar" | "vocabulary" | "clarity" | "logic" | "accuracy";
  }[];
  alignment: {
    source: string;
    student: string;
    status: "accurate" | "partial" | "missing" | "mistranslated";
    explanation: string;
    suggestion: string;
  }[];
  improvedEssay: string;
  advancedSuggestions?: ExpressionSuggestion[];
  notebookHighlights?: {
    correctionIndex: number;
    wrong: string;
    right: string;
    title: string;
    pattern: string;
  }[];
  exercises: { title: string; instruction: string }[];
};
export type Review = {
  queue?: import("./ai-jobs").ReviewQueueInfo;
  id: string;
  draftId: string | null;
  status: "processing" | "completed" | "failed";
  createdAt: string;
  input: EssayInput;
  question: Question;
  feedback: Feedback | null;
  error: string | null;
  model: string;
  references: MethodRule[];
};
export type ScoredSample = {
  id: string;
  prompt_id: string;
  score: number;
  max_score: number;
  text: string;
  pdf_pages: number[];
  transcription_uncertainties?: string[];
};
export type SamplePrompt = {
  id: string;
  exam_level: ExamLevel;
  task_type: Task;
  prompt_text: string;
  chinese_source?: string;
  pdf_pages: number[];
};
export type OfficialSamples = {
  provenance: {
    source_url: string;
    document_name: string;
    notes: string;
    warning: string;
  };
  prompts: SamplePrompt[];
  samples: ScoredSample[];
};
export const wordCount = (text: string) =>
  text.match(/[A-Za-z0-9]+(?:['’\-][A-Za-z0-9]+)*/g)?.length || 0;
export const prescribedFirstSentence = (q: Question) =>
  q.stem.match(/begins with the sentence\s*["“]([^"”]+)["”]/i)?.[1] || "";
export const assessedWordCount = (essay: string, q: Question) => {
  const given = prescribedFirstSentence(q);
  const body = /not including the sentence given/i.test(q.stem) && given && essay.trimStart().startsWith(given) ? essay.trimStart().slice(given.length) : essay;
  return wordCount(body);
};
export const levelLabel = (level: ExamLevel) =>
  level === "CET4" ? "四级" : "六级";
export const taskLabel = (task: Task) => (task === "writing" ? "写作" : "翻译");
export const isSupplementaryQuestion = (q: Pick<Question, "sourceType">) => q.sourceType === "original_adaptation";
export const questionSessionLabel = (q: Pick<Question, "sourceType" | "session" | "set">) =>
  isSupplementaryQuestion(q) ? "中国文化补充题 · 原创改编" : q.session ? `${q.session} · 第${q.set}套` : "自选题目";
export const bandFor = (score: number) =>
  score === 0
    ? "0"
    : score >= 13
      ? "13-15"
      : score >= 10
        ? "10-12"
        : score >= 7
          ? "7-9"
          : score >= 4
            ? "4-6"
            : "1-3";
