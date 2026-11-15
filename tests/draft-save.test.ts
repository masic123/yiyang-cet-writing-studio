import { test } from "node:test";
import assert from "node:assert/strict";
import { sqliteDatabase } from "../server/database";
import { questions } from "../src/lib/content";
import type { EssayInput } from "../src/lib/types";
import type { Env } from "../worker/types";
import { HttpError } from "../src/lib/http";
import { saveDraft } from "../worker/repository";

function fixture() {
  const { sql, db } = sqliteDatabase(":memory:");
  const env = { DB: db } as Env;
  for (const id of ["owner", "other"]) sql.prepare("INSERT INTO users(id,name,email,password,created_at) VALUES(?,?,?,?,?)")
    .run(id, id, id + "@example.test", "unused", "2026-11-04T00:00:00.000Z");
  const input = (patch: Partial<EssayInput> = {}): EssayInput => ({
    questionId: questions().find(q => q.task === "writing" && !q.needsVisual)!.id,
    essay: "An exact synthetic answer, with its original punctuation.",
    title: "Synthetic draft",
    targetScore: 11,
    ...patch,
  });
  const row = (id: string) => sql.prepare("SELECT * FROM drafts WHERE id=?").get(id)!;
  return { sql, env, input, row };
}

const conflict = (error: unknown) => error instanceof HttpError && error.status === 409 && error.code === "DRAFT_CONFLICT";

test("identical saves and stale retries return the current version without writing", async t => {
  const f = fixture(); t.after(() => f.sql.close());
  const created = await saveDraft(f.env, "owner", f.input());
  const originalRow = f.row(created.id);
  assert.deepEqual(await saveDraft(f.env, "owner", f.input(), created.id, created.version), created);
  assert.deepEqual(f.row(created.id), originalRow);
  const changedInput = f.input({ essay: "A genuinely changed synthetic answer." });
  const changed = await saveDraft(f.env, "owner", changedInput, created.id, created.version);
  assert.equal(changed.version, 2);
  const changedRow = f.row(created.id);
  assert.deepEqual(await saveDraft(f.env, "owner", changedInput, created.id, created.version), changed);
  assert.deepEqual(f.row(created.id), changedRow);
  assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM drafts").get()!.n, 1);
});

test("object key order does not create a conflict, while essay whitespace remains meaningful", async t => {
  const f = fixture(); t.after(() => f.sql.close());
  const input = f.input({ outline: { analysis: "Analyse the task", position: "A position", paragraphs: [{ id: "body", point: "One point", support: "A supporting example" }], ending: "A conclusion" } });
  const saved = await saveDraft(f.env, "owner", input);
  const reordered: EssayInput = {
    outline: { ending: input.outline!.ending, paragraphs: [{ support: "A supporting example", point: "One point", id: "body" }], position: input.outline!.position, analysis: input.outline!.analysis },
    targetScore: input.targetScore, title: input.title, essay: input.essay, questionId: input.questionId,
  };
  const before = f.row(saved.id);
  assert.deepEqual(await saveDraft(f.env, "owner", reordered, saved.id, saved.version + 10), saved);
  assert.deepEqual(f.row(saved.id), before);
  await assert.rejects(saveDraft(f.env, "owner", { ...reordered, essay: " " + reordered.essay }, saved.id, saved.version + 10), conflict);
  assert.deepEqual(f.row(saved.id), before);
});

test("a stale different answer cannot overwrite another page or bypass ownership", async t => {
  const f = fixture(); t.after(() => f.sql.close());
  const saved = await saveDraft(f.env, "owner", f.input());
  const newest = await saveDraft(f.env, "owner", f.input({ essay: "The other page's latest answer." }), saved.id, saved.version);
  const before = f.row(saved.id);
  await assert.rejects(saveDraft(f.env, "owner", f.input(), saved.id, saved.version), conflict);
  await assert.rejects(saveDraft(f.env, "other", newest.input, saved.id, newest.version), error => error instanceof HttpError && error.status === 404);
  assert.deepEqual(f.row(saved.id), before);
});

test("concurrent identical saves safely resolve a CAS loser to the winning draft", async t => {
  const f = fixture(); t.after(() => f.sql.close());
  const saved = await saveDraft(f.env, "owner", f.input());
  const input = f.input({ essay: "The identical updated answer from two pending requests." });
  const results = await Promise.all([
    saveDraft(f.env, "owner", input, saved.id, saved.version),
    saveDraft(f.env, "owner", input, saved.id, saved.version),
  ]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0].version, 2);
  assert.equal(f.row(saved.id).version, 2);
  assert.deepEqual(JSON.parse(String(f.row(saved.id).input)), input);
});

test("concurrent different saves keep one winner and reject the stale CAS loser", async t => {
  const f = fixture(); t.after(() => f.sql.close());
  const saved = await saveDraft(f.env, "owner", f.input());
  const inputs = [f.input({ essay: "One page's new answer." }), f.input({ essay: "Another page's different answer." })];
  const results = await Promise.allSettled(inputs.map(input => saveDraft(f.env, "owner", input, saved.id, saved.version)));
  const winners = results.filter(result => result.status === "fulfilled");
  const losers = results.filter(result => result.status === "rejected");
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.ok(conflict(losers[0].reason));
  assert.equal(f.row(saved.id).version, 2);
  assert.deepEqual(JSON.parse(String(f.row(saved.id).input)), winners[0].value.input);
});
