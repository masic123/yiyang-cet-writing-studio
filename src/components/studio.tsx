"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import FriendSiteLink from "./friend-site-link";
import FontSizeControl from "./font-size-control";
import Leaderboard from "./leaderboard";
import MobileNavigation from "./mobile-navigation";
import OfficialGroup from "./official-group";
import SentencePractice from "./sentence-practice";
import ClientUpdateNotice from "./client-update-notice";
import SiteAnnouncement from "./site-announcement";
import StudioMotion from "./studio-motion";
import { useTargetPreference } from "@/lib/use-target-preference";
import { useAuthSession } from "@/lib/use-auth-session";
import { createReviewViewState, pollReview, reviewProgress } from "@/lib/review-progress";
import { createDraftSaveFlight, reconcileLocalDraftMeta, savedDraftSwitchStatus, type DraftSaveMeta } from "@/lib/draft-save-client";
import {
  ArrowRight,
  BookOpen,
  BookBookmark,
  BellSimple,
  Check,
  CheckCircle,
  ChalkboardTeacher,
  CaretDown,
  Clock,
  DownloadSimple,
  FileText,
  FloppyDisk,
  GraduationCap,
  HouseLine,
  Info,
  NotePencil,
  Plus,
  SignOut,
  SpinnerGap,
  Target,
  UploadSimple,
  UserCircle,
  Translate,
  FileArrowUp,
  ArrowCounterClockwise,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import type {
  Draft,
  EssayInput,
  Question,
  Review,
  User,
  ExamLevel,
  Task,
} from "@/lib/types";
import { wordCount, levelLabel, taskLabel, isSupplementaryQuestion, questionSessionLabel } from "@/lib/types";
import { api, ApiError, AuthDialog } from "./ui";
import QuestionBank from "./question-bank";
import Report, { downloadText } from "./report";
import SupplementaryResources, { type SupplementaryTab } from "./supplementary-resources";
import AITeacher from "./ai-teacher";
import MistakeNotebook from "./mistake-notebook";
import CustomQuestionDialog from "./custom-question";
import HandwrittenAnswerDialog from "./handwritten-answer";
import { hasOutline } from "@/lib/outline";
type View = "writer" | "bank" | "history" | "notebook" | "resources" | "teacher" | "report" | "sentences";
const fresh = (id: number, targetScore = 11): EssayInput => ({
  questionId: id,
  essay: "",
  targetScore,
  title: "",
});
const dateLabel = (date: string) =>
  new Date(date).toLocaleString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
export default function Studio({
  initialQuestion,
  total,
}: {
  initialQuestion: Question;
  total: number;
}) {
  const [view, setView] = useState<View>("writer");
  const [resourceTab, setResourceTab] = useState<SupplementaryTab>("writing");
  const { user, setUser, authLoaded, authError, invitation, reconnect } = useAuthSession(api, "cet:session-expired");
  const [loginOpen, setLoginOpen] = useState(false);
  const [announcementOpen, setAnnouncementOpen] = useState(false);
  useEffect(() => { if (user) setLoginOpen(false); }, [user?.id]);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [questions, setQuestions] = useState<Question[]>([initialQuestion]);
  const [bankReady, setBankReady] = useState(false);
  const [bankError, setBankError] = useState("");
  const [input, setInput] = useState<EssayInput>(fresh(initialQuestion.id));
  const [hydrated, setHydrated] = useState(false);
  const hydratedOwner = useRef<string | null>(null);
  const [draftMeta, setDraftMeta] = useState<DraftSaveMeta | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [sentenceRevision, setSentenceRevision] = useState(0);

  const [selectedReview, setSelectedReviewState] = useState<Review | null>(null);
  const [saving, setSaving] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [reviewConnectionNotice, setReviewConnectionNotice] = useState("");
  const [localSaved, setLocalSaved] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [draftConflict, setDraftConflict] = useState<{ scope: string; message: string } | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [importerAvailable, setImporterAvailable] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customKey, setCustomKey] = useState(0);
  const [editingCustom, setEditingCustom] = useState(false);
  const [answerGeneration, setAnswerGeneration] = useState(0);
  const [answerOpen, setAnswerOpen] = useState(false);
  const [answerBusy, setAnswerBusy] = useState(false);
  const [localSaveError, setLocalSaveError] = useState(false);
  const [customSeed, setCustomSeed] = useState<
    NonNullable<EssayInput["customQuestion"]>
  >({
    stem: "",
    sourceText: "",
    examType: "CET4",
    task: "writing",
    needsVisual: false,
    wordMin: 120,
    wordMax: 180,
  });
  const [timerSeconds, setTimerSeconds] = useState(0);
  const [timerOn, setTimerOn] = useState(false);
  const [focus, setFocus] = useState(false);
  const shell = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (view !== "teacher") return;
    const element = shell.current;
    if (!element) return;
    const media = window.matchMedia("(max-width: 767px)");
    const viewport = window.visualViewport;
    let frame = 0;
    let width = window.innerWidth;
    let fullHeight = window.innerHeight;
    const update = () => {
      if (!media.matches) {
        element.style.removeProperty("--teacher-viewport-height");
        element.style.removeProperty("--teacher-viewport-top");
        element.removeAttribute("data-teacher-keyboard");
        return;
      }
      if (width !== window.innerWidth) {
        width = window.innerWidth;
        fullHeight = window.innerHeight;
      }
      const height = viewport?.height ?? window.innerHeight;
      const editing = document.activeElement instanceof HTMLElement && !!document.activeElement.closest(".teacher-compose");
      if (!editing) fullHeight = Math.max(fullHeight, height, window.innerHeight);
      element.style.setProperty("--teacher-viewport-height", `${height}px`);
      element.style.setProperty("--teacher-viewport-top", `${viewport?.offsetTop ?? 0}px`);
      element.toggleAttribute("data-teacher-keyboard", fullHeight - height > 120 && (editing || element.hasAttribute("data-teacher-keyboard")));
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); };
    update();
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    document.addEventListener("focusin", schedule);
    document.addEventListener("focusout", schedule);
    media.addEventListener("change", schedule);
    return () => {
      cancelAnimationFrame(frame);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("focusin", schedule);
      document.removeEventListener("focusout", schedule);
      media.removeEventListener("change", schedule);
      element.style.removeProperty("--teacher-viewport-height");
      element.style.removeProperty("--teacher-viewport-top");
      element.removeAttribute("data-teacher-keyboard");
    };
  }, [view]);
  const generation = useRef(0);
  const reviewView = useRef(createReviewViewState());
  const draftScope = useRef(0);
  const draftSaveFlight = useRef(createDraftSaveFlight<Draft | undefined>());
  const ownerRef = useRef(user?.id ?? null);
  ownerRef.current = user?.id ?? null;
  const inputRef = useRef(input);
  inputRef.current = input;
  function applyInput(next: EssayInput) {
    inputRef.current = next;
    setInput(next);
  }
  const targetPreference = useTargetPreference(user?.id ?? null, authLoaded, api, (target, owner) => {
    if (ownerRef.current !== owner || inputRef.current.targetScore === target) return;
    const next = { ...inputRef.current, targetScore: target };
    inputRef.current = next;
    setInput(next);
  });
  const metaRef = useRef(draftMeta);
  function currentReviewScope() { return `${ownerRef.current}:${generation.current}`; }
  function selectReview(review: Review | null) {
    const scope = currentReviewScope();
    reviewView.current.choose(scope, review);
    setSelectedReviewState(review);
    setReviewConnectionNotice("");
    setReviewing(reviewView.current.busy(scope));
  }
  function currentDraftScope() { return `${ownerRef.current}:${generation.current}:${draftScope.current}`; }
  function changeDraftMeta(meta: DraftSaveMeta | null) {
    metaRef.current = meta;
    setDraftMeta(meta);
  }
  function changeDraftContext() {
    draftScope.current++;
    setDraftConflict(null);
    setSaving(false);
  }
  function draftSwitchSnapshot() { return { scope: currentDraftScope(), input: structuredClone(inputRef.current) }; }
  function canSwitchDraft(snapshot: ReturnType<typeof draftSwitchSnapshot>) {
    const status = savedDraftSwitchStatus(snapshot, { scope: currentDraftScope(), input: inputRef.current });
    if (status === "changed") showMessage("保存期间有新输入，已保留最新作答。请重试切换练习。");
    return status === "ready";
  }
  const requestRef = useRef<{ signature: string; key: string } | null>(null);
  const textImport = useRef<HTMLInputElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const selectedQuestion = useMemo<Question>(
    () =>
      input.questionId === null && !user
        ? initialQuestion
        : input.questionId === null
        ? customAsQuestion(input)
        : questions.find((q) => q.id === input.questionId) || initialQuestion,
    [input.questionId, input.customQuestion, questions, initialQuestion, user],
  );
  const words = user ? wordCount(input.essay) : 0;
  const practiceTitle = `${levelLabel(selectedQuestion.examType)}${taskLabel(selectedQuestion.task)}`;
  const pageTitle = view === "writer" ? practiceTitle : ({ bank: "题库", history: "我的练习", notebook: "错题本", resources: "补充资料", teacher: "AI 老师", report: "批改报告", sentences: "逐句精翻" }[view]);
  useEffect(() => { document.title = `${pageTitle} · 译洋`; }, [pageTitle]);
  const minimum = selectedQuestion.wordLimit?.min || 0;
  const isTranslation = selectedQuestion.task === "translation";
  const paragraphCount = user && input.essay.trim()
    ? input.essay.trim().split(/\n\s*\n/).length
    : 0;
  useEffect(() => {
    const onExpired = () => {
      generation.current++;
      changeDraftContext();
      setUser(null);
      setHydrated(true);
      setTimerOn(false);
      setReviewing(false);
      setSaving(false);
      setCustomOpen(false);
      setAnswerOpen(false);
      setAnswerBusy(false);
      setView("writer");
      setLoginOpen(true);
      setError("登录已失效，当前已返回游客浏览。请重新登录后继续练习。");
    };
    window.addEventListener("cet:session-expired", onExpired);
    api<{ configured: boolean; questionImportAvailable: boolean }>(
      "/api/config",
    )
      .then((r) => {
        setConfigured(r.configured);
        setImporterAvailable(r.questionImportAvailable);
      })
      .catch(() => setConfigured(false));
    api<{ questions: Question[] }>("/api/questions")
      .then((r) => {
        setQuestions(r.questions);
        setBankReady(true);
      })
      .catch(() => setBankError("题库载入失败，请刷新页面重试。"));
    return () => window.removeEventListener("cet:session-expired", onExpired);
  }, [setUser]);
  useEffect(() => {
    if (!authLoaded) return;
    const id = ++generation.current;
    changeDraftContext();
    let active = true;
    hydratedOwner.current = null;
    setHydrated(false);
    setDrafts([]);
    setReviews([]);
    selectReview(null);
    changeDraftMeta(null);
    setLocalSaved(false);
    applyInput(fresh(inputRef.current.questionId || initialQuestion.id, targetPreference.current()));
    if (!user) {
      setTimerOn(false);
      setReviewing(false);
      setSaving(false);
      setCustomOpen(false);
      setAnswerOpen(false);
      setAnswerBusy(false);
      setHydrated(true);
      return () => {
        active = false;
      };
    }
    const key = `cet:draft:${user.id}`;
    let local: {
      input: EssayInput;
      meta: { id: string; version: number } | null;
      updatedAt: number;
    } | null = null;
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (
          typeof parsed.input?.essay === "string" &&
          typeof parsed.input.targetScore === "number" &&
          parsed.input.targetScore >= 1 &&
          parsed.input.targetScore <= 15
        )
          local = parsed;
      }
    } catch {}
    Promise.all([
      api<{ drafts: Draft[] }>("/api/drafts"),
      api<{ reviews: Review[] }>("/api/reviews"),
    ])
      .then(([d, r]) => {
        if (!active || generation.current !== id) return;
        setDrafts(d.drafts);
        setReviews(r.reviews);
        const latest = d.drafts[0];
        if (
          local &&
          (local.input.essay.trim() || hasOutline(local.input.outline) || !latest || local.updatedAt > new Date(latest.updatedAt).getTime())
        ) {
          const restored = reconcileLocalDraftMeta(local, d.drafts);
          applyInput({ ...local.input, targetScore: targetPreference.current() });
          changeDraftMeta(restored.meta);
          if (restored.detached) setNotice("云端草稿已有其他版本，本机作答已保留；下次保存会另存为新草稿。");
        } else if (latest) {
          applyInput({ ...latest.input, targetScore: targetPreference.current() });
          changeDraftMeta({ id: latest.id, version: latest.version });
        }
        hydratedOwner.current = user.id;
        setHydrated(true);
      })
      .catch(() => {
        if (!active || generation.current !== id) return;
        if (local) {
          applyInput({ ...local.input, targetScore: targetPreference.current() });
          changeDraftMeta(local.meta);
        }
        hydratedOwner.current = user.id;
        setHydrated(true);
        setError("账号草稿暂时没有同步成功，本机内容已保留。可稍后重新保存。");
      });
    return () => {
      active = false;
    };
  }, [user?.id, authLoaded, initialQuestion.id]);
  useEffect(() => {
    if (!hydrated || !user || hydratedOwner.current !== user.id) return;
    setLocalSaved(false);
    const persist = () => {
      try {
        localStorage.setItem(
          `cet:draft:${user.id}`,
          JSON.stringify({
            input,
            meta: draftMeta,
            updatedAt: Date.now(),
          }),
        );
        setLocalSaved(true);
        setLocalSaveError(false);
      } catch {
        setLocalSaved(false);
        setLocalSaveError(true);
      }
    };
    const timeout = setTimeout(persist, 600);
    window.addEventListener("pagehide", persist);
    window.addEventListener("beforeunload", persist);
    return () => {
      clearTimeout(timeout);
      persist();
      window.removeEventListener("pagehide", persist);
      window.removeEventListener("beforeunload", persist);
    };
  }, [input, draftMeta, hydrated, user?.id]);
  useEffect(() => {
    if (!timerOn) return;
    const start = Date.now() - timerSeconds * 1000;
    const interval = setInterval(
      () => setTimerSeconds(Math.floor((Date.now() - start) / 1000)),
      1000,
    );
    return () => clearInterval(interval);
  }, [timerOn]); // elapsed time survives pauses
  useEffect(() => {
    if (!notice) return;
    const timeout = setTimeout(() => setNotice(""), 6000);
    return () => clearTimeout(timeout);
  }, [notice]);
  useEffect(() => {
    setReviewConnectionNotice("");
    if (!user || !selectedReview || selectedReview.status !== "processing") return;
    const scope = currentReviewScope();
    const token = reviewView.current.capture(scope, selectedReview.id);
    if (!token) return;
    const expectedReviewId = selectedReview.id;
    return pollReview<Review>({
      read: async (signal) => (await api<{ review: Review }>(`/api/reviews?id=${encodeURIComponent(expectedReviewId)}`, { signal })).review,
      receive: (review) => {
        if (review.id !== expectedReviewId || !reviewView.current.accept(token, review, currentReviewScope())) return;
        setSelectedReviewState(review);
        setReviews((old) => [review, ...old.filter((r) => r.id !== review.id)]);
        setReviewing(reviewView.current.busy(currentReviewScope()));
        if (review.status !== "processing") requestRef.current = null;
      },
      problem: (message, stopped) => {
        if (!reviewView.current.owns(token, currentReviewScope())) return;
        setReviewConnectionNotice(message);
        if (stopped) {
          reviewView.current.block(token, currentReviewScope());
          setReviewing(reviewView.current.busy(currentReviewScope()));
        }
      },
      visible: () => document.visibilityState === "visible",
    });
  }, [user?.id, selectedReview?.id, selectedReview?.status]);

  function navigate(next: View) {
    setView(next);
    setFocus(false);
    setError("");
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  async function openSavedReview(id: string) {
    if (!user) { setLoginOpen(true); return; }
    const token = reviewView.current.beginOpen(currentReviewScope(), id);
    setReviewing(reviewView.current.busy(currentReviewScope()));
    try {
      const result = await api<{ review: Review }>(`/api/reviews?id=${encodeURIComponent(id)}`);
      if (result.review.id !== id || !reviewView.current.accept(token, result.review, currentReviewScope())) return;
      setSelectedReviewState(result.review);
      setReviewing(reviewView.current.busy(currentReviewScope()));
      navigate("report");
    } catch (error) {
      if (!reviewView.current.owns(token, currentReviewScope())) return;
      reviewView.current.block(token, currentReviewScope());
      setReviewing(reviewView.current.busy(currentReviewScope()));
      setError((error as Error).message);
    }
  }

  function update(patch: Partial<EssayInput>) {
    if (!user) {
      setLoginOpen(true);
      return;
    }
    const next = { ...inputRef.current, ...patch, targetScore: targetPreference.current() };
    inputRef.current = next;
    setInput(next);
    setError("");
  }
  function showMessage(message: string) {
    setNotice(message);
    setError("");
  }
  async function save(snapshot = inputRef.current, options: { copy?: boolean } = {}): Promise<Draft | undefined> {
    if (!user) {
      setLoginOpen(true);
      return;
    }
    const scope = currentDraftScope();
    const meta = options.copy ? null : metaRef.current;
    const payload = { input: structuredClone(snapshot), ...(meta ? { id: meta.id, version: meta.version } : {}) };
    const body = JSON.stringify(payload);
    return draftSaveFlight.current.run(scope, body, async () => {
      if (scope !== currentDraftScope()) return;
      setSaving(true);
      try {
        const result = await api<{ draft: Draft }>("/api/drafts", { method: "POST", body });
        if (scope !== currentDraftScope()) return;
        changeDraftMeta({ id: result.draft.id, version: result.draft.version });
        setDraftConflict(null);
        setDrafts((old) => [result.draft, ...old.filter((d) => d.id !== result.draft.id)]);
        return result.draft;
      } catch (error) {
        if (scope !== currentDraftScope()) return;
        if (error instanceof ApiError && error.code === "DRAFT_CONFLICT") {
          const message = "云端草稿已有其他版本，当前作答已保留。可以另存当前草稿，保留两个版本。";
          setDraftConflict({ scope, message });
          throw new ApiError(message, error.status, error.code);
        }
        throw error;
      } finally {
        if (scope === currentDraftScope()) setSaving(false);
      }
    });
  }
  async function saveConflictCopy() {
    if (!draftConflict || draftConflict.scope !== currentDraftScope()) return;
    setError("");
    try {
      if (await save(inputRef.current, { copy: true })) showMessage("当前作答已另存为新草稿，云端原稿保持不变。");
    } catch (error) { setError((error as Error).message); }
  }
  async function manualSave() {
    setError("");
    try {
      if (await save()) showMessage("草稿已保存到你的账号。");
    } catch (error) {
      setError((error as Error).message);
    }
  }
  async function submitReview() {
    if (!user) {
      setLoginOpen(true);
      return;
    }
    if (reviewing || reviewView.current.busy(currentReviewScope()) || saving || draftSaveFlight.current.busy(currentDraftScope())) return;
    if (words < (isTranslation ? 1 : 30)) {
      setError(isTranslation ? "请先填写已完成的英文译文；有漏译也可以提交评分。" : "请至少写 30 个英文单词再提交批改。");
      editor.current?.focus();
      return;
    }
    if (configured === false) {
      setError("批改服务尚未配置。你仍然可以保存草稿，稍后再来批改。");
      return;
    }
    setError("");
    const snapshot = structuredClone(inputRef.current);
    const id = generation.current;
    const submission = reviewView.current.beginSubmission(currentReviewScope());
    setReviewing(true);
    setTimerOn(false);
    try {
      const saved = await save(snapshot);
      if (!saved || id !== generation.current) {
        if (id === generation.current) {
          reviewView.current.finishSubmission(submission, undefined, currentReviewScope());
          setReviewing(reviewView.current.busy(currentReviewScope()));
        }
        return;
      }
      const signature = JSON.stringify(snapshot);
      if (requestRef.current?.signature !== signature)
        requestRef.current = { signature, key: crypto.randomUUID() };
      const result = await api<{ review: Review }>("/api/reviews", {
        method: "POST",
        body: JSON.stringify({
          input: snapshot,
          draftId: saved.id,
          requestKey: requestRef.current!.key,
        }),
      });
      if (id !== generation.current) return;
      const selected = reviewView.current.finishSubmission(submission, result.review, currentReviewScope());
      setReviews((old) => [result.review, ...old.filter((r) => r.id !== result.review.id)]);
      setReviewing(reviewView.current.busy(currentReviewScope()));
      if (selected) {
        setSelectedReviewState(result.review);
        navigate("report");
      }
      if (result.review.status !== "processing") requestRef.current = null;
    } catch (error) {
      if (id === generation.current) {
        const current = reviewView.current.finishSubmission(submission, undefined, currentReviewScope());
        if (current) setError((error as Error).message);
        setReviewing(reviewView.current.busy(currentReviewScope()));
        requestRef.current = null;
        api<{ reviews: Review[] }>("/api/reviews")
          .then((r) => { if (id === generation.current) setReviews(r.reviews); })
          .catch(() => {});
      }
    }
  }
  async function chooseQuestion(q: Question) {
    if (!user) {
      applyInput(fresh(q.id, targetPreference.current()));
      navigate("writer");
      return;
    }
    if (reviewing || saving || draftSaveFlight.current.busy(currentDraftScope())) return;
    if (answerBusy) {
      setAnswerOpen(true);
      return;
    }
    const beforeSwitch = draftSwitchSnapshot();
    try {
      if (
        beforeSwitch.input.essay.trim() ||
        hasOutline(beforeSwitch.input.outline)
      ) {
        await save(beforeSwitch.input);
      }
      if (!canSwitchDraft(beforeSwitch)) return;
      changeDraftContext();
      changeDraftMeta(null);
      update(fresh(q.id, targetPreference.current()));
      setTimerOn(false);
      setTimerSeconds(0);
      navigate("writer");
    } catch (err) {
      setError((err as Error).message);
    }
  }
  async function newExercise() {
    if (!user) {
      setLoginOpen(true);
      return;
    }
    await chooseQuestion(
      selectedQuestion.id ? selectedQuestion : initialQuestion,
    );
  }
  function switchTrack(examType: ExamLevel, task: Task) {
    if (
      selectedQuestion.examType === examType &&
      selectedQuestion.task === task
    )
      return;
    const matching = questions.filter(q => q.examType === examType && q.task === task);
    const q = (isSupplementaryQuestion(selectedQuestion) && task === "translation"
      ? matching.find(q => isSupplementaryQuestion(q) && q.topic === selectedQuestion.topic)
      : undefined) || matching[0];
    if (q) void chooseQuestion(q);
  }
  function openCustom(edit = false) {
    if (!user) {
      setLoginOpen(true);
      return;
    }
    if (answerBusy) {
      setAnswerOpen(true);
      return;
    }
    setEditingCustom(edit);
    setCustomSeed(
      (edit ? input.customQuestion : undefined) || {
        stem: "",
        sourceText: "",
        task: selectedQuestion.task,
        examType: selectedQuestion.examType,
        needsVisual: false,
        wordMin: selectedQuestion.examType === "CET4" ? 120 : 150,
        wordMax: selectedQuestion.examType === "CET4" ? 180 : 200,
      },
    );
    setCustomKey((v) => v + 1);
    setCustomOpen(true);
  }
  async function useCustom(q: NonNullable<EssayInput["customQuestion"]>) {
    if (!user) {
      setLoginOpen(true);
      return;
    }
    if (reviewing || saving || draftSaveFlight.current.busy(currentDraftScope())) return;
    if (answerBusy) {
      setAnswerOpen(true);
      return;
    }
    if (editingCustom && inputRef.current.questionId === null) {
      update({ ...inputRef.current, customQuestion: q });
      setCustomOpen(false);
      showMessage("题目已更新，作答已保留。");
      return;
    }
    const beforeSwitch = draftSwitchSnapshot();
    try {
      if (
        beforeSwitch.input.essay.trim() ||
        hasOutline(beforeSwitch.input.outline)
      ) {
        await save(beforeSwitch.input);
      }
      if (!canSwitchDraft(beforeSwitch)) return;
      changeDraftContext();
      changeDraftMeta(null);
      update({
        ...fresh(initialQuestion.id, targetPreference.current()),
        questionId: null,
        customQuestion: q,
      });
      setCustomOpen(false);
      setTimerOn(false);
      setTimerSeconds(0);
      navigate("writer");
      showMessage("自选题目已就绪，可以开始练习。");
    } catch (err) {
      setError((err as Error).message);
    }
  }
  async function logout() {
    if (reviewing || saving || draftSaveFlight.current.busy(currentDraftScope())) return;
    if (answerBusy) {
      setAnswerOpen(true);
      return;
    }
    try {
      await api("/api/auth", {
        method: "POST",
        body: JSON.stringify({ action: "logout" }),
      });
      setAnswerGeneration((v) => v + 1);
      generation.current++;
      setHydrated(false);
      setTimerOn(false);
      setUser(null);
      navigate("writer");
      showMessage("已退出账号，当前为游客浏览。");
    } catch (error) {
      setError((error as Error).message);
    }
  }
  async function importEssay(file?: File) {
    if (!user) {
      setLoginOpen(true);
      return;
    }
    if (!file) return;
    if (file.size > 120000) {
      setError("文本文件太大，请选择不超过 120KB 的 TXT 文件。");
      return;
    }
    const scope = currentDraftScope();
    const text = await file.text();
    if (scope !== currentDraftScope()) return;
    if (text.length > 30000) {
      setError("作答最多支持 30000 个字符。");
      return;
    }
    update({ essay: text });
    showMessage("正文已从文本文件导入。");
  }
  const navItems = [
    { id: "writer" as const, label: "写译练习", icon: NotePencil },
    { id: "bank" as const, label: "题库", icon: BookOpen },
    { id: "sentences" as const, label: "逐句精翻", icon: Translate },
    { id: "history" as const, label: "我的练习", icon: Clock },
    { id: "notebook" as const, label: "错题本", icon: BookBookmark },
    { id: "resources" as const, label: "补充资料", icon: GraduationCap },
    { id: "teacher" as const, label: "AI 老师", icon: ChalkboardTeacher },
  ];
  const loading = !hydrated || !bankReady;
  const announcementBlocked = loading || !authLoaded || loginOpen || customOpen || answerOpen || mobileMenuOpen || reviewing || saving || answerBusy || focus;
  return (
    <div ref={shell} className={`app-shell ${focus ? "focus-mode" : ""} ${view === "teacher" ? "teacher-active" : ""}`}>
      <StudioMotion root={shell} scene={view} questionKey={`${selectedQuestion.id}:${selectedQuestion.examType}:${selectedQuestion.task}:${selectedQuestion.stem}:${selectedQuestion.sourceText || ""}`} />
      <a className="skip-link" href="#main">
        跳到主要内容
      </a>
      <aside className="sidebar">
        <a href="/" className="brand" aria-label="译洋首页">
          <span className="brand-mark">
            <NotePencil size={26} weight="light" />
          </span>
          <span>
            <b>译洋</b>
          </span>
        </a>
        <div className="sidebar-divider" />
        <nav aria-label="主导航">
          {navItems.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${view === item.id || (view === "report" && item.id === "history") ? "active" : ""}`}
              aria-current={view === item.id ? "page" : undefined}
              onClick={() => navigate(item.id)}
            >
              <item.icon
                size={21}
                weight={view === item.id ? "fill" : "regular"}
              />
              <span>{item.label}</span>
              {item.id === "bank" && <small>{total}</small>}
            </button>
          ))}
        </nav>
        <Leaderboard placement="sidebar" user={user} refreshKey={reviews.filter(r => r.status === "completed").map(r => r.id).join(",") + ":" + sentenceRevision} />
        <div className="sidebar-bottom">
          {user ? (
            <div className="user-card">
              <span className="avatar">
                {user.name.slice(0, 1).toUpperCase()}
              </span>
              <div>
                <b>{user.name}</b>
                <small title={user.email}>{user.email}</small>
              </div>
              <button
                className="icon-button"
                aria-label="退出账号"
                disabled={reviewing || saving}
                onClick={logout}
              >
                <SignOut size={18} />
              </button>
            </div>
          ) : (
            <button
              className="user-card login-button" disabled={!authLoaded}
              onClick={() => setLoginOpen(true)}
            >
              <UserCircle size={30} weight="light" />
              <span>
                <b>{authLoaded ? "游客浏览" : "正在恢复登录…"}</b>
              </span>
              <ArrowRight size={17} />
            </button>
          )}
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <HouseLine size={17} />
            <span>译洋</span>
            <span className="slash">/</span>
            <b>
              {
                {
                  writer: practiceTitle,
                  bank: "题库",
                  sentences: "逐句精翻",
                  history: "我的练习",
                  notebook: "错题本",
                  resources: "补充资料",
                  teacher: "AI 老师",
                  report: "批改报告",
                }[view]
              }
            </b>
          </div>
          <div className="topbar-right">
            <a href="/download" className="client-download-link" title="下载客户端" aria-label="下载客户端"><DownloadSimple size={18} /><span>下载客户端</span></a>
            <button type="button" className="announcement-shortcut" aria-label="网站公告" title="网站公告" disabled={announcementBlocked} onClick={() => setAnnouncementOpen(true)}><BellSimple size={17} /><span>网站公告</span></button>
            <FontSizeControl />
            <OfficialGroup compact />
            <FriendSiteLink />
            {authLoaded && !user && <button className="text-button desktop-signin" onClick={() => setLoginOpen(true)}>登录 / 注册<ArrowRight size={16} /></button>}
            <button type="button" className="mobile-account icon-button" disabled={!authLoaded} aria-label={user ? "账号与设置" : "登录账号"} onClick={() => user ? setMobileMenuOpen(true) : setLoginOpen(true)}><UserCircle size={23} /></button>
          </div>
        </header>
        <MobileNavigation items={navItems} view={view} onNavigate={navigate} open={mobileMenuOpen} onOpenChange={setMobileMenuOpen} user={user} onLogin={() => setLoginOpen(true)} onLogout={() => void logout()} busy={reviewing || saving || answerBusy} />
        <main id="main" className="workspace">
          <ClientUpdateNotice />
          {authError && <div className="error-box workspace-error" role="alert">
            <WarningCircle size={20} /><span>{authError}</span>
            <button className="text-button" onClick={reconnect}>重新连接</button>
          </div>}
          {notice && (
            <div className="toast" role="status">
              <CheckCircle size={19} />
              {notice}
              <button
                className="icon-button"
                aria-label="关闭提示"
                onClick={() => setNotice("")}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {draftConflict && draftConflict.scope === currentDraftScope() && (
            <div className="error-box workspace-error" role="alert">
              <WarningCircle size={20} />
              <span>{draftConflict.message}</span>
              <button className="text-button" disabled={saving || reviewing} onClick={() => void saveConflictCopy()}>另存当前草稿</button>
            </div>
          )}
          {error && error !== draftConflict?.message && (
            <div className="error-box workspace-error" role="alert">
              <WarningCircle size={20} />
              <span>{error}</span>
              <button
                className="icon-button"
                aria-label="关闭错误提示"
                onClick={() => setError("")}
              >
                <X size={17} />
              </button>
            </div>
          )}
          {view === "writer" && (
            <>
              <div className="practice-header">
                <div className="practice-title-row">
                  <div className="page-intro writer-intro"><h1>{practiceTitle}</h1></div>
                  {!focus && <Leaderboard placement="mobile" user={user} refreshKey={reviews.filter(r => r.status === "completed").map(r => r.id).join(",") + ":" + sentenceRevision} />}
                </div>
                <div className="practice-header-actions">
              <div className="practice-toolbar" aria-label="练习设置">
                <div className="practice-target">
                  <label htmlFor="target" title="目标用于制定提升建议，不影响客观评分"><Target size={18} />我的目标</label>
                  <div className="practice-target-control" style={{ maxWidth: 220 }}>
                    <select
                      id="target"
                      aria-label="我的目标"
                      aria-description="目标用于制定提升建议，不影响客观评分"
                      aria-describedby="target-sync-status"
                      title={targetPreference.message}
                      value={input.targetScore}
                      onChange={(e) => targetPreference.choose(Number(e.target.value))}
                      disabled={loading || saving || reviewing || !authLoaded}
                    >
                      {Array.from({ length: 15 }, (_,i) => i + 1).map((score) => (
                        <option key={score} value={score}>目标 {score} / 15 分</option>
                      ))}
                    </select>
                    <span id="target-sync-status" data-status={targetPreference.status} className={`target-sync-status ${targetPreference.status === "error" || targetPreference.status === "saving" ? "" : "sr-only"}`} role="status">{targetPreference.message}{targetPreference.status === "error" && <> <button type="button" className="text-button" onClick={targetPreference.retry}>重试保存</button></>}</span>
                  </div>
                </div>
              </div>
                <button
                  className="text-button upload-question-trigger"
                  disabled={reviewing || saving}
                  onClick={() => openCustom()}
                >
                  <FileArrowUp size={18} />
                  上传题目
                </button>
                </div>
              </div>
              <div className="practice-switcher">
                <div
                  className="track-tabs"
                  role="group"
                  aria-label="选择级别与任务"
                >
                  {(
                    [
                      ["CET4", "writing"],
                      ["CET4", "translation"],
                      ["CET6", "writing"],
                      ["CET6", "translation"],
                    ] as [ExamLevel, Task][]
                  ).map(([level, task]) => (
                    <button
                      key={level + task}
                      aria-pressed={
                        selectedQuestion.examType === level &&
                        selectedQuestion.task === task
                      }
                      disabled={!bankReady || reviewing || saving}
                      onClick={() => switchTrack(level, task)}
                    >
                      {task === "writing" ? (
                        <NotePencil size={18} />
                      ) : (
                        <Translate size={18} />
                      )}
                      <span>
                        {levelLabel(level)}
                        {taskLabel(task)}
                      </span>
                    </button>
                  ))}
                </div>

              </div>
              <div className="writing-grid practice-layout">
                <div className="writing-main">
                  <section className="question-panel">
                    <div className="panel-topline">
                      <div className="inline-tags">
                        <span className="tag">
                          {levelLabel(selectedQuestion.examType)} ·{" "}
                          {taskLabel(selectedQuestion.task)}
                        </span>
                        <span className="small muted">
                          {questionSessionLabel(selectedQuestion)}
                        </span>
                      </div>
                      <button
                        className="text-button"
                        disabled={reviewing || saving}
                        onClick={() => navigate("bank")}
                      >
                        <BookOpen size={16} />
                        换一题
                        <ArrowRight size={15} />
                      </button>
                    </div>
                    <div className="question-title">
                      <h2>
                        {selectedQuestion.category}
                      </h2>
                    </div>
                    <div className="question-stem" lang="en">
                      {selectedQuestion.stem.split(/\n\s*\n/).map((part, i) => (
                        <p
                          key={i}
                          className={isTranslation ? "question-rubric" : ""}
                        >
                          {part}
                        </p>
                      ))}
                    </div>
                    {isTranslation && (
                      <div className="translation-source">
                        <p lang="zh-CN">{selectedQuestion.sourceText}</p>
                      </div>
                    )}
                    {selectedQuestion.images.length > 0 && (
                      <div className="question-images">
                        {selectedQuestion.images.map((img, i) => (
                          <a
                            key={img}
                            href={img}
                            target="_blank"
                            rel="noreferrer"
                            aria-label={`放大题图 ${i + 1}`}
                          >
                            <img
                              src={img}
                              alt={`${selectedQuestion.name}的题图`}
                              loading="lazy"
                            />
                          </a>
                        ))}
                      </div>
                    )}
                    {selectedQuestion.needsVisual &&
                      (!user || !input.customQuestion?.visualDescription) && (
                        <p className="inline-note">
                          <Info size={17} />
                          本题依赖图画或图表，图意尚待核验。当前批改只提供语言与结构反馈，不给整体分。
                        </p>
                      )}
                    {user && input.customQuestion?.visualDescription && (
                      <div className="visual-context">
                        <b>你确认的图意 / 数据</b>
                        <p>{input.customQuestion.visualDescription}</p>
                        <small className="muted">
                          批改以此文字说明为依据。
                        </small>
                      </div>
                    )}
                    <div className="question-footnote">
                      <span>
                        <Clock size={15} />
                        建议用时 {selectedQuestion.timeLimit} 分钟
                        {selectedQuestion.wordLimit && (
                          <>
                            {" "}
                            · {selectedQuestion.wordLimit.min}-
                            {selectedQuestion.wordLimit.max} 词
                          </>
                        )}
                      </span>
                      {selectedQuestion.sourceType === "custom" && (
                        <button
                          className="text-button"
                          onClick={() => openCustom(true)}
                        >
                          编辑自选题目
                          <ArrowRight size={14} />
                        </button>
                      )}
                    </div>
                  </section>
                  <section className="editor-panel" aria-busy={reviewing}>
                    <div className="editor-heading">
                      <div className="question-title">
                        <label htmlFor="essay">
                          {isTranslation
                            ? "写下你的英文译文"
                            : "写下你的英文作答"}
                        </label>
                      </div>
                      <div className="editor-tools">
                        <input
                          ref={textImport}
                          type="file"
                          accept=".txt,text/plain"
                          hidden
                          disabled={!user}
                          onChange={(e) => {
                            void importEssay(e.target.files?.[0]);
                            e.target.value = "";
                          }}
                        />
                        <button
                          className="icon-button"
                          title="导入 TXT 正文"
                          aria-label="导入 TXT 正文"
                          disabled={reviewing || loading || !user}
                          onClick={() => textImport.current?.click()}
                        >
                          <UploadSimple size={19} />
                        </button>
                        <button
                          className="icon-button"
                          title="下载当前正文"
                          aria-label="下载当前正文"
                          disabled={!user || !input.essay}
                          onClick={() =>
                            downloadText(input.essay, "四六级写译-练习草稿.txt")
                          }
                        >
                          <DownloadSimple size={19} />
                        </button>
                        <button
                          className="text-button focus-toggle"
                          onClick={() => setFocus(!focus)}
                        >
                          {focus ? "退出专注" : "专注练习"}
                        </button>
                      </div>
                    </div>
                    <div className="essay-title-row">
                      <input
                        className="essay-title"
                        aria-label="练习标题"
                        placeholder="练习标题（可选）"
                        maxLength={120}
                        value={user ? input.title : ""}
                        onChange={(e) => update({ title: e.target.value })}
                        disabled={loading || reviewing || !user}
                      />
                      <button
                        className={`timer ${timerOn ? "running" : ""}`}
                        title="点击开始或暂停计时"
                        aria-label={`${String(Math.floor(timerSeconds / 60)).padStart(2, "0")}:${String(timerSeconds % 60).padStart(2, "0")}，${timerOn ? "暂停练习计时" : "开始练习计时"}`}
                        onClick={() => setTimerOn(!timerOn)}
                        disabled={reviewing || !user}
                      >
                        <Clock size={16} />
                        {String(Math.floor(timerSeconds / 60)).padStart(2, "0")}
                        :{String(timerSeconds % 60).padStart(2, "0")}
                      </button>
                      <button
                        className="icon-button timer-reset"
                        aria-label="重置计时"
                        title="重置计时"
                        disabled={reviewing || !user}
                        onClick={() => {
                          setTimerOn(false);
                          setTimerSeconds(0);
                        }}
                      >
                        <ArrowCounterClockwise size={16} />
                      </button>
                    </div>
                    <div className="answer-entry">
                      <button
                        className="button secondary"
                        disabled={reviewing || loading}
                        onClick={() => (user ? setAnswerOpen(true) : setLoginOpen(true))}
                      >
                        {answerBusy ? (
                          <SpinnerGap size={18} className="spin" />
                        ) : (
                          <FileArrowUp size={18} />
                        )}
                        {answerBusy ? "查看手写识别进度" : "上传手写答案"}
                      </button>
                    </div>
                    <textarea
                      id="essay"
                      ref={editor}
                      className="essay-editor"
                      lang="en"
                      placeholder={
                        !user
                          ? "登录后开始作答…"
                          : loading
                          ? "正在恢复草稿…"
                          : isTranslation
                            ? "输入英文译文…"
                            : "输入英文作答…"
                      }
                      spellCheck={false}
                      maxLength={30000}
                      value={user ? input.essay : ""}
                      onChange={(e) => update({ essay: e.target.value })}
                      readOnly={!user}
                      disabled={loading || reviewing}
                      aria-describedby="word-count save-status"
                    />
                    <div className="editor-stats">
                      <div>
                        <span id="word-count">
                          <b>{words}</b>
                          {minimum
                            ? ` / ${selectedQuestion.wordLimit!.min}-${selectedQuestion.wordLimit!.max} 词`
                            : " 词"}
                        </span>
                        <span className="stat-separator">·</span>
                        <span>{paragraphCount} 段</span>
                        {minimum > 0 && words > 0 && (
                          <span className="word-hint">
                            {words < minimum
                              ? "尚未达到题面词数"
                              : words > selectedQuestion.wordLimit!.max
                                ? "已超过题面上限"
                                : "符合题面词数"}
                          </span>
                        )}
                      </div>
                      <span
                        id="save-status"
                        className={`save-status ${localSaveError ? "error-text" : ""}`}
                        role="status"
                      >
                        {!user ? "游客模式 · 只读" : localSaveError ? (
                          "本机保存失败，请下载备份"
                        ) : localSaved ? (
                          <>
                            <Check size={14} />
                            本机已保存
                          </>
                        ) : (
                          "正在保存到本机"
                        )}
                      </span>
                    </div>
                    <div className="editor-actions">
                      <button
                        className="button secondary"
                        disabled={loading || saving || reviewing}
                        onClick={manualSave}
                      >
                        {saving ? (
                          <SpinnerGap size={18} className="spin" />
                        ) : (
                          <FloppyDisk size={18} />
                        )}
                        {user ? "保存到账号" : "登录后保存"}
                      </button>
                      <button
                        className="button primary review-button"
                        disabled={loading || reviewing || saving}
                        onClick={submitReview}
                      >
                        {reviewing ? (
                          <SpinnerGap size={19} className="spin" />
                        ) : (
                          <NotePencil size={19} />
                        )}{" "}
                        {reviewing ? "已提交批改" : user ? "提交批改" : "登录后批改"}
                        {!reviewing && <ArrowRight size={18} />}
                      </button>
                    </div>
                    {reviewing && (
                      <div className="review-progress" role="status">
                        <div className="loading-line" />
                        <b>正在认真阅读你的{isTranslation ? "译文" : "作答"}</b>
                        <span>
                          {isTranslation
                            ? "核对原文信息、逻辑和英文表达"
                            : "检查任务完成、思路与语言表达"}
                          ，通常需要一至两分钟。草稿已保存。
                        </span>
                      </div>
                    )}
                  </section>
                </div>
              </div>
            </>
          )}
          {view === "sentences" && <SentencePractice user={user} onLogin={() => setLoginOpen(true)} onAward={() => setSentenceRevision(value => value + 1)} />}
          {view === "bank" &&
            (bankError ? (
              <div className="error-box" role="alert">
                {bankError}
                <button
                  className="text-button"
                  onClick={() => location.reload()}
                >
                  重新载入
                </button>
              </div>
            ) : (
              <QuestionBank
                questions={bankReady ? questions : []}
                initialSupplementary={isSupplementaryQuestion(selectedQuestion)}
                onCultureMaterials={() => { setResourceTab("culture"); navigate("resources"); }}
                onSelect={(q) => void chooseQuestion(q)}
                onCustom={() => openCustom()}
              />
            ))}
          {view === "resources" && (
            <SupplementaryResources
              tab={resourceTab}
              onTabChange={setResourceTab}
            />
          )}
          <div className="teacher-host" hidden={view !== "teacher"}>
            <AITeacher
              key={user?.id || "guest"}
              user={user}
              configured={configured}
              active={view === "teacher"}
              context={{ questionId: input.questionId, ...(input.questionId === null ? { customQuestion: input.customQuestion } : {}) }}
              questionLabel={`${levelLabel(selectedQuestion.examType)}${taskLabel(selectedQuestion.task)} · ${questionSessionLabel(selectedQuestion)}`}
              onLogin={() => setLoginOpen(true)}
              onLibrary={() => { setResourceTab(isSupplementaryQuestion(selectedQuestion) ? "culture" : selectedQuestion.task === "translation" ? "translation" : "writing"); navigate("resources"); }}
              onReview={(id) => void openSavedReview(id)}
              onHistory={() => navigate("history")}
            />
          </div>
          <MistakeNotebook
            key={`notebook:${user?.id || "guest"}`}
            user={user}
            active={view === "notebook"}
            revision={reviews.map((r) => `${r.id}:${r.status}`).join(",")}
            configured={configured}
            importerAvailable={importerAvailable}
            onLogin={() => setLoginOpen(true)}
            onReview={(id) => void openSavedReview(id)}
            onWriter={() => navigate("writer")}
          />
          {view === "history" && (
            <div className="history-view">
              <div className="page-intro">
                <h1>我的练习</h1>
              </div>
              {!user ? (
                <div className="empty">
                  <UserCircle size={36} weight="light" />
                  <h2>登录后查看你的练习</h2>
                  <p>草稿和批改记录仅当前账号可见。</p>
                  <button className="button primary" onClick={() => setLoginOpen(true)}>
                    邮箱登录<ArrowRight size={17} />
                  </button>
                </div>
              ) : <>
              <div className="between history-heading">
                <h2>
                  账号草稿{" "}
                  <span className="muted">{drafts.length}</span>
                </h2>
                <button
                  className="button secondary"
                  onClick={newExercise}
                  disabled={reviewing || saving}
                >
                  <Plus size={17} />
                  新建练习
                </button>
              </div>
              {drafts.length === 0 ? (
                <div className="empty small-empty">
                  <FileText size={32} weight="light" />
                  <h3>从第一道题开始</h3>
                  <p>
                    当前练习会自动保存在本机；保存到账号后可在这里继续。
                  </p>
                  <button
                    className="text-button"
                    onClick={() => (user ? navigate("writer") : setLoginOpen(true))}
                  >
                    继续练习
                    <ArrowRight size={16} />
                  </button>
                </div>
              ) : (
                <div className="history-list">
                  {drafts.map((d) => (
                    <button
                      className="history-row"
                      key={d.id}
                      onClick={async () => {
                        if (reviewing || saving || draftSaveFlight.current.busy(currentDraftScope())) return;
                        if (answerBusy) {
                          setAnswerOpen(true);
                          return;
                        }
                        if (metaRef.current?.id === d.id) { navigate("writer"); return; }
                        const beforeSwitch = draftSwitchSnapshot();
                        try {
                          if (
                            (beforeSwitch.input.essay.trim() || hasOutline(beforeSwitch.input.outline)) &&
                            metaRef.current?.id !== d.id
                          )
                            await save(beforeSwitch.input);
                        } catch (err) {
                          setError((err as Error).message);
                          return;
                        }
                        if (!canSwitchDraft(beforeSwitch)) return;
                        changeDraftContext();
                        update(d.input);
                        changeDraftMeta({ id: d.id, version: d.version });
                        setTimerOn(false);
                        setTimerSeconds(0);
                        navigate("writer");
                      }}
                    >
                      <span className="history-icon">
                        <FileText size={23} />
                      </span>
                      <div>
                        <h3>
                          {d.input.title ||
                            questions.find((q) => q.id === d.input.questionId)
                              ?.name ||
                            "自选题目练习"}
                        </h3>
                        <p>
                          {d.wordCount} 词
                          {hasOutline(d.input.outline) ? " · 含笔记" : ""} ·{" "}
                          {dateLabel(d.updatedAt)}
                        </p>
                      </div>
                      <span className="tag subtle">草稿</span>
                      <ArrowRight size={19} />
                    </button>
                  ))}
                </div>
              )}
              <h2 className="history-heading">
                批改记录 <span className="muted">{reviews.length}</span>
              </h2>
              {reviews.length === 0 ? (
                <div className="empty small-empty">
                  <NotePencil size={31} weight="light" />
                  <h3>第一份反馈，从提交开始</h3>
                  <p>完成正文后，点击“提交批改”。</p>
                </div>
              ) : (
                <div className="history-list">
                  {reviews.map((r) => (
                    <button
                      className="history-row"
                      key={r.id}
                      onClick={() => {
                        selectReview(r);
                        navigate("report");
                      }}
                    >
                      <span className="history-icon">
                        {r.question.task === "translation" ? (
                          <Translate size={23} />
                        ) : (
                          <NotePencil size={23} />
                        )}
                      </span>
                      <div>
                        <h3>{r.input.title || r.question.name}</h3>
                        <p>
                          {levelLabel(r.question.examType)}
                          {taskLabel(r.question.task)} ·{" "}
                          {dateLabel(r.createdAt)}
                        </p>
                      </div>
                      <span
                        className={`tag ${r.status === "failed" ? "warning" : r.status === "processing" ? "subtle" : ""}`}
                      >
                        {r.status === "processing"
                          ? reviewProgress(r).label
                          : r.status === "failed"
                            ? "未完成"
                            : r.feedback?.holisticScore !== null
                              ? `${r.feedback?.holisticScore ?? "未评"} / 15`
                              : "语言反馈"}
                      </span>
                      <ArrowRight size={19} />
                    </button>
                  ))}
                </div>
              )}
              </>}
            </div>
          )}
          {user && view === "report" && selectedReview && (
            <Report
              key={selectedReview.id}
              review={selectedReview}
              connectionNotice={reviewConnectionNotice}
              onBack={() => navigate("history")}
              onNotebook={() => navigate("notebook")}
              onRewrite={async () => {
                if (reviewing || saving || draftSaveFlight.current.busy(currentDraftScope())) return;
                if (answerBusy) {
                  setAnswerOpen(true);
                  return;
                }
                const beforeSwitch = draftSwitchSnapshot();
                try {
                  if (beforeSwitch.input.essay.trim() || hasOutline(beforeSwitch.input.outline)) await save(beforeSwitch.input);
                  if (!canSwitchDraft(beforeSwitch)) return;
                  changeDraftContext();
                  update({
                    ...selectedReview.input,
                    targetScore: targetPreference.current(),
                    title: `${selectedReview.input.title || selectedReview.question.name} · 修改练习`,
                  });
                  changeDraftMeta(null);
                  setTimerOn(false);
                  setTimerSeconds(0);
                  navigate("writer");
                } catch (error) {
                  if (beforeSwitch.scope === currentDraftScope()) setError((error as Error).message);
                }
              }}
            />
          )}
        </main>
      </div>
      <SiteAnnouncement
        open={announcementOpen}
        onOpenChange={setAnnouncementOpen}
        blocked={announcementBlocked}
        autoBlocked={timerOn || !!input.essay.trim() || view === "teacher" || view === "sentences" || view === "report" || view === "notebook"}
        onMaterials={() => { setResourceTab("culture"); navigate("resources"); }}
      />
      <AuthDialog
        open={authLoaded && !user && loginOpen}
        onOpenChange={setLoginOpen}
        invitationRequired={invitation}
        onSuccess={(u) => {
          setHydrated(false);
          setUser(u);
          showMessage(`欢迎，${u.name}。`);
        }}
      />
      {user && <CustomQuestionDialog
        key={customKey}
        open={customOpen}
        onOpenChange={setCustomOpen}
        seed={customSeed}
        loggedIn={!!user}
        importerAvailable={importerAvailable}
        onLogin={() => {
          setCustomOpen(false);
          setLoginOpen(true);
        }}
        onSave={(q) => void useCustom(q)}
      />}
      {user && <HandwrittenAnswerDialog
        key={`${answerGeneration}:${input.questionId}:${input.customQuestion?.stem || ""}:${input.customQuestion?.sourceText || ""}`}
        open={answerOpen}
        onOpenChange={setAnswerOpen}
        loggedIn={!!user}
        importerAvailable={importerAvailable}
        currentEssay={input.essay}
        onBusyChange={setAnswerBusy}
        onLogin={() => {
          setAnswerOpen(false);
          setLoginOpen(true);
        }}
        onApply={(text) => {
          update({ essay: text });
          showMessage("已导入核对后的手写答案。现在可以继续编辑或提交批改。");
          requestAnimationFrame(() => editor.current?.focus());
        }}
      />}
    </div>
  );
}
function customAsQuestion(input: EssayInput): Question {
  const c = input.customQuestion!;
  return {
    id: 0,
    name: "自选题目",
    stem: c.stem,
    sourceText: c.sourceText,
    examType: c.examType,
    task: c.task,
    session: "",
    set: 0,
    category: "自选题目",
    topic: "",
    sourceType: "custom",
    sourceUrl: "",
    transcriptionStatus: "user_provided",
    timeLimit: 30,
    images: [],
    needsVisual: c.needsVisual,
    wordLimit:
      c.task === "writing"
        ? {
            min: c.wordMin || (c.examType === "CET4" ? 120 : 150),
            max: c.wordMax || (c.examType === "CET4" ? 180 : 200),
          }
        : null,
  };
}
