// Local acceptance fixture. Uses synthetic data and the configured services.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, basename } from "node:path";
const root = resolve("storage/verification");
await mkdir(root, { recursive: true });
const origin = "http://127.0.0.1:3002";
let credentials;
try {
  credentials = JSON.parse(
    await readFile(resolve(root, "credentials.json"), "utf8"),
  );
} catch {
  credentials = {
    email: `local-qa-${Date.now()}@example.test`,
    password: crypto.randomUUID() + "Aa1!",
    name: "功能验收",
  };
  await writeFile(
    resolve(root, "credentials.json"),
    JSON.stringify(credentials),
  );
}
let cookie = "";
async function request(path, method = "GET", body) {
  const response = await fetch(origin + path, {
    method,
    headers: {
      ...(body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body
      ? body instanceof FormData
        ? body
        : JSON.stringify(body)
      : undefined,
    signal: AbortSignal.timeout(175000),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(`${path} ${response.status}: ${data.error}`);
  if (response.headers.get("set-cookie"))
    cookie = response.headers.get("set-cookie").split(";")[0];
  return data;
}
try {
  await request("/api/auth", "POST", { ...credentials, action: "login" });
} catch {
  await request("/api/auth", "POST", { ...credentials, action: "register" });
}
const config = await request("/api/config");
assert.equal(config.application, "cet-writing");
assert.equal(config.configured, true);
const { questions } = await request("/api/questions");
assert.equal(questions.length, 304);
for (let i = 1; i < questions.length; i++)
  assert.ok(questions[i - 1].session >= questions[i].session);
const essay =
  "I support the proposal that every university student should join at least one research project. It can help students learn how to ask questions and check evidence instead of simply remembering facts.\n\nFor example, a small survey about campus transport would give students a chance to collect data and explain their findings. They can also learn to work with classmates and plan their time. However, the requirement should be flexible. A large project may be too difficult for first-year students, and some departments may not have enough supervisors.\n\nTo make the proposal practical, universities should provide small group projects and clear guidance. Students could choose a topic related to their major and complete it over a term. With these arrangements, research experience would become both useful and manageable.";
const translation =
  "There is an old saying in China: a teacher for one day is a father for life. Chinese people believe that teachers not only pass on knowledge but also teach students how to behave. In ancient times, students held a grand ceremony when they first met their teachers, which showed the high status of teachers. To promote the fine tradition of respecting teachers, China has designated September 10 as Teachers' Day since 1985. On this day, students express their respect for teachers in various ways. Respecting teachers is a traditional virtue of the Chinese nation, and it has been carried forward in today's society.";
await writeFile(resolve(root, "essay-fixture.txt"), essay);
await writeFile(
  resolve(root, "custom-question.md"),
  "Directions: For this part, write a response about the benefits and difficulties of joining a university research project. You should write at least 120 words but not more than 180 words.",
);
const input = (task) => ({
  questionId: task === "writing" ? 420260611 : 420260612,
  essay: task === "writing" ? essay : translation,
  targetScore: 11,
  title: `验收样例 · ${task === "writing" ? "四级写作" : "四级翻译"}`,
});
if (process.argv.includes("--reviews")) {
  for (const task of process.argv.includes("--translation")
    ? ["translation"]
    : ["writing", "translation"]) {
    try {
      const data = input(task);
      const { draft } = await request("/api/drafts", "POST", { input: data });
      const { review } = await request("/api/reviews", "POST", {
        input: data,
        draftId: draft.id,
        requestKey: crypto.randomUUID(),
      });
      assert.equal(review.status, "completed");
      assert.ok(Number.isInteger(review.feedback.holisticScore));
      assert.ok(
        review.feedback.holisticScore >= 0 &&
          review.feedback.holisticScore <= 15,
      );
      assert.equal(review.feedback.assessmentScope, "full");
      if (task === "translation") assert.ok(review.feedback.alignment.length);
      assert.equal(
        (await request(`/api/reviews?id=${review.id}`)).review.id,
        review.id,
      );
      await writeFile(
        resolve(root, `${task}-review.json`),
        JSON.stringify(review, null, 2),
      );
      console.log(
        JSON.stringify({
          task,
          reviewId: review.id,
          score: review.feedback.holisticScore,
          corrections: review.feedback.corrections.length,
          alignment: review.feedback.alignment.length,
        }),
      );
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
const ocrIndex = process.argv.indexOf("--ocr");
if (ocrIndex >= 0) {
  const file = resolve(process.argv[ocrIndex + 1]);
  const form = new FormData();
  form.set("file", new File([await readFile(file)], basename(file)));
  let job = await request("/api/answer-imports", "POST", form);
  console.log(JSON.stringify({ ocr: "submitted", id: job.id }));
  const deadline = Date.now() + 280000;
  while (job.status === "processing" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    job = await request(`/api/answer-imports?id=${job.id}`);
  }
  await writeFile(
    resolve(root, "ocr-result.json"),
    JSON.stringify(job, null, 2),
  );
  console.log(
    JSON.stringify({
      ocr: job.status,
      characters: job.text?.length || 0,
      error: job.error,
    }),
  );
  assert.equal(job.status, "completed");
  assert.ok(job.text?.trim());
}
console.log("Local smoke finished.");
