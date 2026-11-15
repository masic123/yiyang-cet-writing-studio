import { targetPreferenceRoute } from "./target-preferences";
import { membershipRoute, registrationMembershipStatements } from "./membership";
import { cardShopRoute } from "./card-shop";
import { sentencePracticeRoute } from "./sentence-practice";
import { z } from "zod";
import { runInteractive, fencedDatabase } from "./ai-capacity";
import { assertOrigin, body, endpoint, HttpError, reviewFailureMessage } from "../src/lib/http";
import { questions, methods, officialSamples, resolveQuestion } from "../src/lib/content";
import { essaySchema } from "../src/lib/validation";
import { wordCount } from "../src/lib/types";
import { providerConfig, assessEssayForOwner } from "../src/lib/reviewer";
import { answerTeacher, teacherSchema } from "../src/lib/teacher";
import { generateNotebookPractice, checkNotebookPractice, generatePracticeSchema, practiceAnswerSchema } from "../src/lib/notebook-practice";
import type { PracticeContent, PracticeTarget } from "../src/lib/notebook-types";
import {
  getNotebookData, updateNotebookItem, beginNotebookExercise, finishNotebookExercise,
  revealNotebookExercise, beginNotebookAttempt, finishNotebookAttempt, getNotebookExercise,
} from "./notebook";
import {
  currentUser,
  requireUser,
  hashPassword,
  verifyPassword,
  rateLimit,
  createSession,
  destroySession,
  renewedSessionCookie,
} from "./auth";
import {
  listDrafts,
  saveDraft,
  listReviews,
  getReview,
  beginReview,
  finishReview,
  expireReviews,
} from "./repository";
import type { Env } from "./types";
import { durableDatabase } from "./store";
import { withLeaderboard } from "./leaderboard";
import { teacherHistory } from "./teacher-history";
import { registrationNoticeStatement, requireRegistrationNotice } from "./registration-notice";
export { WritingStore } from "./store";
const credentials = z.object({
  action: z.enum(["login", "register", "logout"]),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("请填写有效邮箱。")
    .max(200)
    .optional(),
  password: z.string().min(8, "密码至少 8 个字符。").max(128).optional(),
  name: z.string().trim().min(1).max(40).optional(),
  code: z.string().max(200).optional(),
  referralCode: z.string().trim().max(40).optional(),
  acceptNotice: z.boolean().optional(),
  noticeVersion: z.string().max(80).optional(),
});
const json = (value: unknown, cookie?: string, status = 200) =>
  Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...(cookie ? { "Set-Cookie": cookie } : {}),
    },
  });
async function auth(request: Request, env: Env) {
  const db = env.AUTH_DB || env.DB;
  const authLimitEnv = { ...env, DB: db };
  if (request.method === "DELETE") {
    assertOrigin(request);
    const user = await requireUser(request, env);
    if (env.AUTH_DB) throw new HttpError(405, "共用账号暂不支持自助注销，请联系管理员处理。 ");
    await env.DB.prepare("DELETE FROM users WHERE id=?").bind(user.id).run();
    return json({ user: null }, await destroySession(request, env));
  }
  if (request.method === "GET")
    return json({
      user: await currentUser(request, env),
      invitationRequired: !!env.REGISTRATION_CODE,
      sharedAccount: !!env.AUTH_DB,
    });
  if (request.method !== "POST") throw new HttpError(405, "请求方式不支持。");
  assertOrigin(request);
  const data = credentials.parse(await body(request, 5000));
  if (data.action === "logout")
    return json({ user: null }, await destroySession(request, env));
  if (!data.email || !data.password)
    throw new HttpError(400, "请填写邮箱和密码。");
  await rateLimit(authLimitEnv, `auth:${data.email}`, 12, 15 * 60000);
  await rateLimit(
    authLimitEnv,
    `auth-ip:${request.headers.get("CF-Connecting-IP") || "local"}`,
    60,
    15 * 60000,
  );
  if (data.action === "register") {
    requireRegistrationNotice(data);
    if (env.REGISTRATION_CODE && data.code !== env.REGISTRATION_CODE)
      throw new HttpError(403, "邀请码不正确。");
    if (!data.name) throw new HttpError(400, "请填写你的昵称。");
    if (
      await db.prepare("SELECT id FROM users WHERE email=?")
        .bind(data.email)
        .first()
    )
      throw new HttpError(409, "该邮箱已注册，请登录。");
    const password = await hashPassword(data.password);
    const id = crypto.randomUUID();
    const memberRegistration = await registrationMembershipStatements(env, id, data.referralCode);
    const createdAt = new Date().toISOString();
    const noticeAcceptance = await registrationNoticeStatement(db, id, createdAt);
    try {
      await db.batch([db.prepare("INSERT INTO users(id,email,name,password,created_at) VALUES(?,?,?,?,?)")
        .bind(id, data.email, data.name, password, createdAt), noticeAcceptance, ...memberRegistration]);
    } catch {
      if (await db.prepare("SELECT id FROM users WHERE email=?").bind(data.email).first())
        throw new HttpError(409, "该邮箱已注册，请登录。");
      throw new HttpError(503, "暂时无法完成注册，请稍后重试。");
    }
    await destroySession(request, env);
    return json(
      { user: { id, email: data.email, name: data.name } },
      await createSession(request, env, id),
    );
  }
  const row = await db.prepare("SELECT * FROM users WHERE email=?")
    .bind(data.email)
    .first<Record<string, string>>();
  if (!row) {
    await hashPassword(data.password);
    throw new HttpError(401, "邮箱或密码不正确。");
  }
  if (!(await verifyPassword(data.password, row.password)))
    throw new HttpError(401, "邮箱或密码不正确。");
  await destroySession(request, env);
  return json(
    { user: { id: row.id, email: row.email, name: row.name } },
    await createSession(request, env, row.id),
  );
}
async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method;
  const targetPreferenceResponse = await targetPreferenceRoute(request, env);
  if (targetPreferenceResponse) return targetPreferenceResponse;
  const shopResponse = await cardShopRoute(request, env);
  if (shopResponse) return shopResponse;
  const sentenceResponse = await sentencePracticeRoute(request, env);
  if (sentenceResponse) return sentenceResponse;
  const memberResponse = await membershipRoute(request, env);
  if (memberResponse) return memberResponse;
  if (url.pathname === "/api/auth") return auth(request, env);
  if (method === "GET" && url.pathname === "/api/config")
    return json({
      ...providerConfig(env),
      application: "cet-writing",
      aiQueue: env.AI_JOBS ? { enabled: true, concurrency: env.AI_JOBS.policy.concurrency, maxPending: env.AI_JOBS.policy.maxPending } : { enabled: false },
      questionImportAvailable: !!env.QUESTION_IMPORT,
      answerImportAvailable: !!env.QUESTION_IMPORT,
    });
  if (method === "GET" && url.pathname === "/api/questions")
    return json({ questions: questions() });
  if (method === "GET" && url.pathname === "/api/methods")
    return json({ methods: methods() });
  if (method === "GET" && url.pathname === "/api/samples")
    return json(officialSamples());
  if (url.pathname === "/api/notebook") {
    const user = await requireUser(request, env);
    if (method !== "GET") throw new HttpError(405, "请求方式不支持。");
    return json(await getNotebookData(env, user.id));
  }
  if (url.pathname === "/api/notebook/items") {
    const user = await requireUser(request, env);
    if (method !== "PATCH") throw new HttpError(405, "请求方式不支持。");
    assertOrigin(request);
    const data = z.object({ id: z.string().uuid(), status: z.enum(["active", "mastered", "ignored"]) }).parse(await body(request, 3000));
    await updateNotebookItem(env, user.id, data.id, data.status);
    return json({ ok: true });
  }
  if (url.pathname === "/api/notebook/reveal") {
    const user = await requireUser(request, env);
    if (method !== "POST") throw new HttpError(405, "请求方式不支持。");
    assertOrigin(request);
    const data = z.object({ id: z.string().uuid() }).parse(await body(request, 3000));
    return json({ exercise: await revealNotebookExercise(env, user.id, data.id) });
  }
  if (url.pathname === "/api/notebook/exercises") {
    const user = await requireUser(request, env);
    if (method !== "POST") throw new HttpError(405, "请求方式不支持。");
    assertOrigin(request);
    const data = generatePracticeSchema.parse(await body(request, 8000));
    const config = providerConfig(env);
    if (!config.configured) throw new HttpError(503, "专项练习尚未连接 DeepSeek。", "NOT_CONFIGURED");
    await rateLimit(env, `notebook-generate:${user.id}`, 6, 15 * 60000);
    await rateLimit(env, `notebook-generate-day:${user.id}`, 30, 24 * 60 * 60000);
    const { exercise, created } = await beginNotebookExercise(env, user.id, data, config.model);
    if (!created) return json({ exercise });
    try {
      const saved = await runInteractive(env, user.id, request.signal, async (signal, requestFetch, stillOwned) => {
        const content = await generateNotebookPractice(exercise.targets, exercise.task, exercise.examType, env, requestFetch, signal);
        return finishNotebookExercise({ ...env, DB: fencedDatabase(env.DB, stillOwned) }, user.id, exercise.id, content);
      });
      return json({ exercise: saved });
    } catch (error) {
      await finishNotebookExercise(env, user.id, exercise.id, null, error instanceof HttpError ? error.message : "生成未完成，请重试。");
      throw error;
    }
  }
  if (url.pathname === "/api/notebook/attempts") {
    const user = await requireUser(request, env);
    if (method !== "POST") throw new HttpError(405, "请求方式不支持。");
    assertOrigin(request);
    const data = practiceAnswerSchema.parse(await body(request, 80000));
    if (!providerConfig(env).configured) throw new HttpError(503, "专项练习尚未连接 DeepSeek。", "NOT_CONFIGURED");
    await rateLimit(env, `notebook-check:${user.id}`, 20, 15 * 60000);
    await rateLimit(env, `notebook-check-day:${user.id}`, 100, 24 * 60 * 60000);
    const { attempt, created, row } = await beginNotebookAttempt(env, user.id, data.exerciseId, data.requestKey, data.answer);
    if (!created) return json({ exercise: await getNotebookExercise(env, user.id, attempt.exerciseId) });
    try {
      const saved = await runInteractive(env, user.id, request.signal, async (signal, requestFetch, stillOwned) => {
        const feedback = await checkNotebookPractice(data.answer, JSON.parse(String(row.content)) as PracticeContent, JSON.parse(String(row.targets)) as PracticeTarget[], env, requestFetch, signal);
        const protectedEnv = { ...env, DB: fencedDatabase(env.DB, stillOwned) };
        await finishNotebookAttempt(protectedEnv, user.id, attempt.id, feedback);
        return getNotebookExercise(protectedEnv, user.id, attempt.exerciseId);
      });
      return json({ exercise: saved });
    } catch (error) {
      await finishNotebookAttempt(env, user.id, attempt.id, null, error instanceof HttpError ? error.message : "检查未完成，作答已保存，请重试。");
      throw error;
    }
  }
  if (url.pathname === "/api/teacher") {
    const user = await requireUser(request, env);
    if (method !== "POST") throw new HttpError(405, "请求方式不支持。");
    assertOrigin(request);
    const input = teacherSchema.parse(await body(request, 160000));
    if (!providerConfig(env).configured)
      throw new HttpError(503, "AI 老师尚未连接，请联系管理员配置 DeepSeek。", "NOT_CONFIGURED");
    await rateLimit(env, `teacher:${user.id}`, 20, 15 * 60000);
    await rateLimit(env, `teacher-day:${user.id}`, 120, 24 * 60 * 60000);
    const history = input.includeHistory === false ? [] : await teacherHistory(env, user.id, input);
    return json(await runInteractive(env, user.id, request.signal, (signal, requestFetch) => answerTeacher(input, env, requestFetch, signal, history)));
  }
  if (["/api/question-imports", "/api/answer-imports"].includes(url.pathname)) {
    const purpose =
      url.pathname === "/api/answer-imports" ? "answer" : "question";
    const user = await requireUser(request, env);
    if (!env.QUESTION_IMPORT)
      throw new HttpError(
        503,
        "当前服务未配置 MinerU 识别，可上传文本或直接粘贴文字。",
        "IMPORT_NOT_CONFIGURED",
      );
    if (method === "POST") {
      assertOrigin(request);
      await rateLimit(env, `import:${user.id}`, 24, 60 * 60000);
      return env.QUESTION_IMPORT.start(request, user.id, purpose);
    }
    if (method === "GET")
      return env.QUESTION_IMPORT.get(
        url.searchParams.get("id") || "",
        user.id,
        purpose,
      );
    throw new HttpError(405, "请求方式不支持。");
  }
  if (url.pathname === "/api/drafts") {
    const user = await requireUser(request, env);
    if (method === "GET")
      return json({ drafts: await listDrafts(env, user.id) });
    if (method !== "POST") throw new HttpError(405, "请求方式不支持。");
    assertOrigin(request);
    await rateLimit(env, `draft:${user.id}`, 100, 60000);
    const data = z
      .object({
        id: z.string().uuid().optional(),
        version: z.number().int().positive().optional(),
        input: essaySchema,
      })
      .parse(await body(request, 1600000));
    return json({
      draft: await saveDraft(env, user.id, data.input, data.id, data.version),
    });
  }
  if (url.pathname === "/api/reviews") {
    const user = await requireUser(request, env);
    if (method === "GET") {
      const id = url.searchParams.get("id");
      if (id) {
        await expireReviews(env, user.id);
        return json({ review: await getReview(env, user.id, id) });
      }
      return json({ reviews: await listReviews(env, user.id) });
    }
    if (method !== "POST") throw new HttpError(405, "请求方式不支持。");
    assertOrigin(request);
    const data = z
      .object({
        input: essaySchema,
        draftId: z.string().uuid().optional(),
        requestKey: z.string().uuid(),
      })
      .parse(await body(request, 1600000));
    let translation: boolean;
    try { translation = resolveQuestion(data.input).task === "translation"; }
    catch { throw new HttpError(400, "没有找到该题目，请重新选择。"); }
    if (wordCount(data.input.essay) < (translation ? 1 : 30))
      throw new HttpError(400, translation ? "请先填写已完成的英文译文；有漏译也可以提交评分。" : "请至少写 30 个英文单词再提交批改。");
    const config = providerConfig(env);
    if (!config.configured)
      throw new HttpError(
        503,
        "批改服务尚未配置，请联系网站管理员。",
        "NOT_CONFIGURED",
      );
    await rateLimit(env, `review:${user.id}`, 12, 10 * 60000);
    const { review, created } = await beginReview(
      env,
      user.id,
      data.input,
      data.requestKey,
      config.model,
      data.draftId,
    );
    if (env.AI_JOBS && review.status === "processing") {
      try {
        await env.AI_JOBS.enqueueReview(user.id, review.id);
      } catch (error) {
        // Admission failure preserves the submitted answer and releases the account's slot.
        if (!env.AI_JOBS.reviewInfo(review.id))
          await finishReview(env, user.id, review.id, null, error instanceof HttpError ? error.message : "批改任务暂时无法接收，作答已保留，请稍后重试。");
        throw error;
      }
      const saved = await getReview(env, user.id, review.id);
      return json({ review: saved }, undefined, saved.status === "processing" ? 202 : 200);
    }
    if (!created) return json({ review });
    try {
      return json({
        review: await finishReview(
          env,
          user.id,
          review.id,
          await assessEssayForOwner(data.input, review.question, env, user.id),
        ),
      });
    } catch (error) {
      await finishReview(
        env,
        user.id,
        review.id,
        null,
        reviewFailureMessage(error),
      );
      throw error;
    }
  }
  throw new HttpError(404, "接口不存在。");
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    let response: Response;
    if (url.pathname.startsWith("/api/")) {
      if (!env.DB && env.STORE)
        env = { ...env, DB: durableDatabase(env.STORE) };
      try {
        response = await withLeaderboard(request, env, () => route(request, env));
      } catch (error) {
        response = await endpoint(async () => {
          throw error;
        });
      }
    } else response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    const renewedCookie = renewedSessionCookie(request);
    if (renewedCookie && !headers.has("Set-Cookie")) headers.set("Set-Cookie", renewedCookie);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("X-Frame-Options", "DENY");
    headers.set("Referrer-Policy", url.pathname === "/promotion" || url.pathname === "/promotion/" || headers.get("Referrer-Policy") === "no-referrer" ? "no-referrer" : "strict-origin-when-cross-origin");
    headers.set(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
    if (url.pathname.startsWith("/api/"))
      headers.set("Cache-Control", "no-store");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
