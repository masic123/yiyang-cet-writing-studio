import test from "node:test";
import assert from "node:assert/strict";
import { AnswerImportRequestError, cleanAnswerText, combineAnswer, readAnswerImportJob, supportedAnswerImage } from "../src/lib/answer-import";

test("answer recognition removes document markup while preserving student's errors and paragraph order", () => {
  const raw =
    "<!-- page 1 -->\n# My answer\n\nStudent is intrested in research.\n\nIt help us alot.";
  assert.equal(
    cleanAnswerText(raw),
    "My answer\n\nStudent is intrested in research.\n\nIt help us alot.",
  );
  assert.match(cleanAnswerText("![unreadable](image.png)"), /未识别/);
});

test("mobile image uploads can use a supported MIME type without a filename extension", () => {
  assert.equal(supportedAnswerImage({ name: "camera", type: "image/jpeg", size: 500 }), true);
  assert.equal(supportedAnswerImage({ name: "answer.png", type: "", size: 500 }), true);
  assert.equal(supportedAnswerImage({ name: "answer.heic", type: "image/heic", size: 500 }), false);
  assert.equal(supportedAnswerImage({ name: "answer.jpg", type: "image/jpeg", size: 10_000_001 }), false);
});

test("recognition progress rejects HTML gateways, missing jobs and malformed success responses", async () => {
  await assert.rejects(readAnswerImportJob(new Response("<html>Bad Gateway</html>", { status: 502 })), /识别进度/);
  await assert.rejects(readAnswerImportJob(Response.json({ error: "未找到这份识别任务，请重新上传。" }, { status: 404 })), (error: unknown) => error instanceof AnswerImportRequestError && error.status === 404);
  await assert.rejects(readAnswerImportJob(Response.json({ id: "test", status: "unknown" })), /无效进度/);
  assert.deepEqual(await readAnswerImportJob(Response.json({ id: "test", status: "processing" })), { id: "test", status: "processing" });
});

test("verified answer appends by default and replaces only when explicitly chosen, with no silent truncation", () => {
  assert.equal(
    combineAnswer("Existing answer.\n", " Page two. ", "append"),
    "Existing answer.\n\nPage two.",
  );
  assert.equal(
    combineAnswer("Existing answer.", "New answer.", "replace"),
    "New answer.",
  );
  assert.throws(() => combineAnswer("Keep this.", "  ", "replace"), /为空/);
  assert.throws(
    () => combineAnswer("a".repeat(29995), "more text", "append"),
    /30000/,
  );
});
