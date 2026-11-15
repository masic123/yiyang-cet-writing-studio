import assert from "node:assert/strict";
import { test } from "node:test";
import { sqliteDatabase } from "../server/database";
import * as http from "../src/lib/http";
import { applyScoringAudit, SCORING_VERSION, scoringFingerprint } from "../src/lib/scoring-audit";
import { assessEssay, assessEssayForOwner } from "../src/lib/reviewer";
import type { EssayInput, Feedback, Question } from "../src/lib/types";

// These are synthetic answers and model responses. No network, real user work,
// configured credentials or production database is used by these tests.
const question: Question = {
  id: 1, name: "修改稿复核降级回归", examType: "CET6", task: "writing",
  session: "", set: 1, category: "建议", topic: "研究项目",
  stem: "Discuss the necessity and practicality of a research project in 40 to 180 words.",
  sourceText: "", wordLimit: { min: 40, max: 180 }, timeLimit: 30,
  sourceType: "custom", sourceUrl: "", images: [], needsVisual: false,
  transcriptionStatus: "verified",
};
const opening = "Research help students apply what they learn.";
const correctedOpening = "Research helps students apply what they learn.";
const essay = `${opening} A small survey can teach them to compare sources and judge evidence. Teachers can guide beginners and limit the project to two weeks. These abilities benefit their future study and career. This makes the requirement both useful and practical.`;
const revision = essay.replace(opening, correctedOpening);
const input: EssayInput = { questionId: 1, title: "合成测试", essay, targetScore: 11 };
const env = { DEEPSEEK_API_KEY: "synthetic-test", DEEPSEEK_MODEL: "synthetic-test-model" };
const grammarFinding = {
  kind: "grammar", severity: "minor", original: opening,
  replacement: correctedOpening, requirement: "",
  reason: "Research是单数主语，表达一般作用时谓语应为helps。",
};
const candidate = () => ({
  corrections: [{ original: opening, replacement: correctedOpening, kind: "grammar", reason: grammarFinding.reason }],
  improvedEssay: revision, advancedSuggestions: [], notebookHighlights: [],
});
const assessment = (answer: string, score: number, findings = [] as typeof grammarFinding[]) => ({
  holisticScore: score,
  summary: "合成复核结果，仅用于检查服务器行为。",
  scoreReason: "评分必须由实际证据支持，不复用候选阶段的分数。",
  taskRelevance: { status: "relevant", reason: "围绕研究项目的必要性和可行性回答问题。" },
  strengths: [{ quote: "A small survey can teach them to compare sources and judge evidence.", explanation: "给出了研究活动能够培养的具体能力。" }],
  taskChecks: [{
    requirement: "necessity and practicality", status: "met",
    evidence: [
      "A small survey can teach them to compare sources and judge evidence.",
      "Teachers can guide beginners and limit the project to two weeks.",
    ],
    explanation: "必要性和实施方式均有实际答卷依据。",
  }],
  findings,
});
const audit = (revisionScore = 11) => ({
  original: assessment(essay, 11, [structuredClone(grammarFinding)]),
  revision: assessment(revision, revisionScore),
  correctionDecisions: [{ index: 0, classification: "error", reason: grammarFinding.reason }],
});
const completion = (value: unknown) => Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(value) } }] });
type Claim = { id: string; claimType: string; side: string; finding?: unknown };

function syntheticProvider(options: {
  auditForAttempt?: (attempt: number) => unknown;
  auditFailureForAttempt?: (attempt: number) => "timeout" | "invalid_json" | undefined;
  editingForAttempt?: (attempt: number) => unknown;
  editingFailureForAttempt?: (attempt: number) => "timeout" | "invalid_json" | undefined;
  invalidClaim?: (claim: Claim) => boolean;
  claimDecisions?: (decisions: { id: string; verdict: string; reason: string }[]) => unknown;
  editing?: unknown;
} = {}) {
  const trace = { editingCalls: 0, auditCalls: 0, claimCalls: 0, claims: [] as Claim[][] };
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const messages = JSON.parse(String(init?.body)).messages;
    const data = JSON.parse(messages[1].content);
    if (Array.isArray(data.claims)) {
      trace.claimCalls++;
      trace.claims.push(data.claims);
      const decisions = data.claims.map((claim: Claim) => ({
        id: claim.id,
        verdict: options.invalidClaim?.(claim) ? "invalid" : "valid",
        reason: options.invalidClaim?.(claim)
          ? "原句一般现在时能够表达普遍作用，要求加入will的指责不成立。"
          : "合成样例中的原句、题目要求和所述判断相符。",
      }));
      return completion({ decisions: options.claimDecisions?.(decisions) ?? decisions });
    }
    if (typeof data.answerA === "string") {
      trace.auditCalls++;
      const failure = options.auditFailureForAttempt?.(trace.auditCalls);
      if (failure === "timeout") throw new Error("synthetic provider connection timed out");
      if (failure === "invalid_json") return Response.json({ choices: [{ finish_reason: "stop", message: { content: "{" } }] });
      return completion(options.auditForAttempt?.(trace.auditCalls) ?? audit());
    }
    trace.editingCalls++;
    const editingFailure = options.editingFailureForAttempt?.(trace.editingCalls);
    if (editingFailure === "timeout") throw new Error("synthetic editing connection timed out");
    if (editingFailure === "invalid_json") return Response.json({ choices: [{ finish_reason: "stop", message: { content: "{" } }] });
    return completion(options.editingForAttempt?.(trace.editingCalls) ?? options.editing ?? candidate());
  };
  return { fetch, trace };
}

test("a verified 11-point original survives a repeatedly unsupported revision score without publishing that revision", async () => {
  const provider = syntheticProvider();
  const feedback = await assessEssay(input, question, env, undefined, provider.fetch);
  assert.equal(provider.trace.auditCalls, 3);
  assert.ok(provider.trace.claimCalls > 0, "the original must also pass independent claim verification");
  assert.equal(feedback.holisticScore, 11);
  assert.equal(feedback.bandRange, "10-12");
  assert.equal(feedback.corrections.length, 1);
  assert.equal(feedback.corrections[0].original, opening);
  assert.deepEqual(feedback.scoringEvidence?.findings, [grammarFinding]);
  assert.equal(feedback.improvedEssay, "", "an unverified candidate must not be displayed as an improved answer");
  assert.equal(feedback.revisionAssessment?.status, "unverified");
  assert.equal(feedback.revisionAssessment?.holisticScore, null);
  assert.equal(feedback.revisionAssessment?.bandRange, null);
  assert.equal(feedback.revisionAssessment?.scoringEvidence, undefined);
  assert.equal(feedback.revisionAssessment?.assessmentFingerprint, undefined);
  assert.equal(feedback.assessmentVersion, SCORING_VERSION);
  assert.ok(feedback.assessmentFingerprint);
  assert.doesNotMatch(feedback.summary, /参考\s*11\/15/);
});

test("a revision that recovers on the next audit still produces the complete verified report", async () => {
  const provider = syntheticProvider({ auditForAttempt: attempt => audit(attempt === 1 ? 11 : 14) });
  const feedback = await assessEssay(input, question, env, undefined, provider.fetch);
  assert.equal(provider.trace.auditCalls, 2);
  assert.equal(feedback.holisticScore, 11);
  assert.equal(feedback.improvedEssay, revision);
  assert.equal(feedback.revisionAssessment?.status, "checked");
  assert.equal(feedback.revisionAssessment?.holisticScore, 14);
  assert.equal(feedback.revisionAssessment?.bandRange, "13-15");
  assert.ok(feedback.revisionAssessment?.scoringEvidence);
  assert.ok(feedback.revisionAssessment?.assessmentFingerprint);
});

for (const failure of ["timeout", "invalid_json"] as const) {
  test(`a ${failure} during a later revision audit preserves the already verified original`, async () => {
    const provider = syntheticProvider({ auditFailureForAttempt: attempt => attempt === 2 ? failure : undefined });
    const feedback = await assessEssay(input, question, env, undefined, provider.fetch);
    assert.equal(provider.trace.auditCalls, 2);
    assert.ok(provider.trace.claimCalls > 0);
    assert.equal(feedback.holisticScore, 11);
    assert.deepEqual(feedback.scoringEvidence?.findings, [grammarFinding]);
    assert.equal(feedback.revisionAssessment?.status, "unverified");
    assert.equal(feedback.revisionAssessment?.holisticScore, null);
    assert.equal(feedback.revisionAssessment?.assessmentFingerprint, undefined);
    assert.equal(feedback.improvedEssay, "");
  });
}

test("a new original-score contradiction invalidates fallback before a subsequent provider failure", async () => {
  const provider = syntheticProvider({
    auditForAttempt: attempt => {
      const raw = audit();
      if (attempt > 1) raw.original.findings = [];
      return raw;
    },
    auditFailureForAttempt: attempt => attempt === 3 ? "timeout" : undefined,
  });
  await assert.rejects(
    assessEssay(input, question, env, undefined, provider.fetch),
    (error: unknown) => error instanceof http.HttpError,
  );
  assert.equal(provider.trace.auditCalls, 3);
  assert.ok(provider.trace.claimCalls > 0, "the first original was verified before the later contradiction");
});

const faultyTeacherSentence = "Teachers can guides beginners and limit the project to two weeks.";
const repairedTeacherSentence = "Teachers can guide beginners and limit the project to two weeks.";
const needsWorkEssay = revision.replace(repairedTeacherSentence, faultyTeacherSentence);
const revisionGrammarFinding = {
  kind: "grammar", severity: "minor", original: faultyTeacherSentence,
  replacement: repairedTeacherSentence, requirement: "",
  reason: "情态动词can之后须使用动词原形guide，不能使用guides。",
};
function needsWorkAudit() {
  const raw = audit(12);
  raw.revision = assessment(needsWorkEssay, 12, [structuredClone(revisionGrammarFinding)]);
  raw.revision.taskChecks[0].evidence[1] = faultyTeacherSentence;
  return raw;
}

for (const failure of ["timeout", "invalid_json"] as const) {
  test(`a ${failure} in optional revision editing keeps the complete report that was already verified`, async () => {
    const provider = syntheticProvider({
      editing: { ...candidate(), improvedEssay: needsWorkEssay },
      auditForAttempt: () => needsWorkAudit(),
      editingFailureForAttempt: attempt => attempt === 2 ? failure : undefined,
    });
    const feedback = await assessEssay(input, question, env, undefined, provider.fetch);
    assert.equal(provider.trace.editingCalls, 2);
    assert.equal(provider.trace.auditCalls, 1);
    assert.equal(feedback.holisticScore, 11);
    assert.deepEqual(feedback.scoringEvidence?.findings, [grammarFinding]);
    assert.equal(feedback.improvedEssay, needsWorkEssay);
    assert.equal(feedback.revisionAssessment?.status, "needs_work");
    assert.equal(feedback.revisionAssessment?.holisticScore, 12);
    assert.deepEqual(feedback.revisionAssessment?.scoringEvidence?.findings, [revisionGrammarFinding]);
    assert.ok(feedback.revisionAssessment?.remainingIssues.includes(revisionGrammarFinding.reason));
    assert.equal(
      feedback.revisionAssessment?.assessmentFingerprint,
      await scoringFingerprint({ ...input, essay: needsWorkEssay }, question, env.DEEPSEEK_MODEL),
    );
  });
}

test("a new revision is committed together with its audit, so its timeout cannot mix old evidence with new text", async () => {
  const provider = syntheticProvider({
    editingForAttempt: attempt => attempt === 1
      ? { ...candidate(), improvedEssay: needsWorkEssay }
      : {
        corrections: [{ original: faultyTeacherSentence, replacement: repairedTeacherSentence, kind: "grammar", reason: revisionGrammarFinding.reason }],
        improvedEssay: revision, advancedSuggestions: [], notebookHighlights: [],
      },
    auditForAttempt: () => needsWorkAudit(),
    auditFailureForAttempt: attempt => attempt === 2 ? "timeout" : undefined,
  });
  const feedback = await assessEssay(input, question, env, undefined, provider.fetch);
  assert.equal(provider.trace.editingCalls, 2);
  assert.equal(provider.trace.auditCalls, 2);
  assert.equal(feedback.holisticScore, 11);
  assert.equal(feedback.improvedEssay, needsWorkEssay);
  assert.equal(feedback.revisionAssessment?.status, "needs_work");
  assert.equal(feedback.revisionAssessment?.holisticScore, 12);
  assert.deepEqual(feedback.revisionAssessment?.scoringEvidence?.findings, [revisionGrammarFinding]);
  assert.equal(
    feedback.revisionAssessment?.assessmentFingerprint,
    await scoringFingerprint({ ...input, essay: needsWorkEssay }, question, env.DEEPSEEK_MODEL),
  );
  assert.notEqual(
    feedback.revisionAssessment?.assessmentFingerprint,
    await scoringFingerprint({ ...input, essay: revision }, question, env.DEEPSEEK_MODEL),
  );
});

test("an unsupported low original score still fails local validation before any claim request", async () => {
  const provider = syntheticProvider({ auditForAttempt: () => {
    const raw = audit();
    raw.original.findings = [];
    return raw;
  } });
  await assert.rejects(
    assessEssay(input, question, env, undefined, provider.fetch),
    (error: unknown) => error instanceof http.HttpError && error.code === "SCORING_INCONSISTENT",
  );
  assert.equal(provider.trace.auditCalls, 3);
  assert.equal(provider.trace.claimCalls, 0);
});

test("revision fallback cannot bypass an independently rejected accusation about the original", async () => {
  const provider = syntheticProvider({
    auditForAttempt: () => {
      const raw = audit();
      raw.original.findings.push({
        kind: "grammar", severity: "minor",
        original: "These abilities benefit their future study and career.",
        replacement: "These abilities will benefit their future study and career.",
        requirement: "", reason: "表达普遍作用也必须加will，这是故意构造的错误规则。",
      });
      return raw;
    },
    invalidClaim: claim => claim.id === "original:1",
  });
  await assert.rejects(
    assessEssay(input, question, env, undefined, provider.fetch),
    (error: unknown) => error instanceof http.HttpError && error.code === "SCORING_INCONSISTENT",
  );
  assert.equal(provider.trace.auditCalls, 3);
  assert.ok(provider.trace.claimCalls > 0);
});

test("the default scoring audit remains strict about a low revision without evidence", () => {
  const reportCandidate = {
    ...candidate(), summary: "未评分候选稿。", holisticScore: null, bandRange: null,
    scoreReason: "未评分。", assessmentScope: "full", diagnostics: [], strengths: [],
    priorities: [], methodChecks: [], paragraphs: [], alignment: [], exercises: [],
  } as Feedback;
  assert.throws(
    () => applyScoringAudit(audit(), input, question, reportCandidate),
    (error: unknown) => error instanceof http.HttpError && error.code === "SCORING_INCONSISTENT",
  );
});

test("an unverified revision cannot be reused as an independently assessed submitted answer", async () => {
  const fallbackProvider = syntheticProvider();
  const fallback = await assessEssay(input, question, env, undefined, fallbackProvider.fetch);
  const { sql, db } = sqliteDatabase(":memory:");
  try {
    const revisedInput = { ...input, essay: revision };
    // Even a stale record accidentally carrying a revision fingerprint must not
    // make an explicitly unverified revision eligible for the reuse path.
    fallback.revisionAssessment!.assessmentFingerprint = await scoringFingerprint(revisedInput, question, env.DEEPSEEK_MODEL);
    sql.prepare("INSERT INTO users VALUES('owner','owner@example.test','owner','!synthetic','2026-11-02')").run();
    sql.prepare("INSERT INTO reviews(id,user_id,input,question,status,feedback,model,refs,request_key,created_at) VALUES('fallback','owner',?,?,'completed',?,'synthetic-test-model','[]','request','2026-11-02')")
      .run(JSON.stringify(input), JSON.stringify(question), JSON.stringify(fallback));
    const cleanAssessment = assessment(revision, 14);
    const freshProvider = syntheticProvider({
      editing: { corrections: [], improvedEssay: revision, advancedSuggestions: [], notebookHighlights: [] },
      auditForAttempt: () => ({ original: structuredClone(cleanAssessment), revision: structuredClone(cleanAssessment), correctionDecisions: [] }),
    });
    const feedback = await assessEssayForOwner(revisedInput, question, { ...env, DB: db }, "owner", freshProvider.fetch);
    assert.ok(freshProvider.trace.editingCalls > 0, "the newly submitted answer needs its own assessment");
    assert.equal(feedback.holisticScore, 14);
    assert.equal(feedback.revisionAssessment?.status, "checked");
    assert.deepEqual(feedback.corrections, []);
  } finally {
    sql.close();
  }
});

test("a partial report for the same original cannot prevent a fresh complete revision audit", async () => {
  const fallbackProvider = syntheticProvider();
  const fallback = await assessEssay(input, question, env, undefined, fallbackProvider.fetch);
  const { sql, db } = sqliteDatabase(":memory:");
  try {
    sql.prepare("INSERT INTO users VALUES('owner','owner@example.test','owner','!synthetic','2026-11-02')").run();
    sql.prepare("INSERT INTO reviews(id,user_id,input,question,status,feedback,model,refs,request_key,created_at) VALUES('partial','owner',?,?,'completed',?,'synthetic-test-model','[]','request','2026-11-02')")
      .run(JSON.stringify(input), JSON.stringify(question), JSON.stringify(fallback));
    const freshProvider = syntheticProvider({ auditForAttempt: () => audit(14) });
    const feedback = await assessEssayForOwner(input, question, { ...env, DB: db }, "owner", freshProvider.fetch);
    assert.ok(freshProvider.trace.editingCalls > 0, "a previous partial report must not be a permanent cache hit");
    assert.equal(freshProvider.trace.auditCalls, 1);
    assert.equal(feedback.holisticScore, 11);
    assert.equal(feedback.revisionAssessment?.status, "checked");
    assert.equal(feedback.revisionAssessment?.holisticScore, 14);
    assert.equal(feedback.improvedEssay, revision);
  } finally {
    sql.close();
  }
});

test("scoring failures expose one user-facing message without internal answer labels or scores", () => {
  const originalFailure = new http.HttpError(502, "评分复核未通过：作答A给8分却没有可核实的实质问题。", "SCORING_INCONSISTENT");
  const revisionFailure = new http.HttpError(502, "评分复核未通过：作答B给11分却没有可核实的实质问题。", "SCORING_INCONSISTENT");
  const message = http.reviewFailureMessage(revisionFailure);
  assert.equal(message, http.reviewFailureMessage(originalFailure));
  assert.doesNotMatch(message, /作答\s*[AB]|\b11\b|\b8\b|重新定档/);
  assert.match(message, /草稿.*保留/);
  assert.match(message, /重试/);
});

for (const defect of ["schema", "citation", "missing"] as const) {
  test(`a ${defect} defect confined to the revision cannot discard the independently verified original`, async () => {
    const provider = syntheticProvider({ auditForAttempt: () => {
      const raw: any = audit(14);
      if (defect === "schema") raw.revision.findings = "invalid model field";
      if (defect === "citation") raw.revision.strengths = [{ quoteId: "b999", explanation: "故意构造的无效修改稿引用。" }];
      if (defect === "missing") delete raw.revision;
      return raw;
    } });
    const feedback = await assessEssay(input, question, env, undefined, provider.fetch);
    assert.equal(feedback.holisticScore, 11);
    assert.deepEqual(feedback.scoringEvidence?.findings, [grammarFinding]);
    assert.equal(feedback.improvedEssay, "");
    assert.equal(feedback.revisionAssessment?.status, "unverified");
    assert.equal(feedback.revisionAssessment?.assessmentFingerprint, undefined);
    assert.ok(provider.trace.claims.every(claims => claims.every(claim => claim.side === "original")));
  });
}

test("an independently rejected revision claim preserves the valid original without publishing the rejected revision", async () => {
  const provider = syntheticProvider({ auditForAttempt: () => audit(14), invalidClaim: claim => claim.side === "revision" });
  const feedback = await assessEssay(input, question, env, undefined, provider.fetch);
  assert.equal(feedback.holisticScore, 11);
  assert.deepEqual(feedback.scoringEvidence?.findings, [grammarFinding]);
  assert.equal(feedback.improvedEssay, "");
  assert.equal(feedback.revisionAssessment?.status, "unverified");
});

test("missing revision decisions do not erase complete valid decisions about the original", async () => {
  const provider = syntheticProvider({ auditForAttempt: () => audit(14), claimDecisions: decisions => decisions.filter(d => !d.id.startsWith("revision:")) });
  const feedback = await assessEssay(input, question, env, undefined, provider.fetch);
  assert.equal(feedback.holisticScore, 11);
  assert.equal(feedback.revisionAssessment?.status, "unverified");
  assert.equal(feedback.improvedEssay, "");
});

test("missing original decisions still fail closed", async () => {
  const provider = syntheticProvider({ auditForAttempt: () => audit(14), claimDecisions: decisions => decisions.filter(d => !d.id.startsWith("original:")) });
  await assert.rejects(assessEssay(input, question, env, undefined, provider.fetch), (error: unknown) => error instanceof http.HttpError && error.code === "SCORING_INCONSISTENT");
});

test("optional improvement cannot discard a complete verified report when its new audit fails", async () => {
  const provider = syntheticProvider({
    editing: { ...candidate(), improvedEssay: needsWorkEssay },
    auditForAttempt: attempt => {
      if (attempt === 1) return needsWorkAudit();
      const raw = needsWorkAudit();
      raw.original.findings = [];
      return raw;
    },
  });
  const feedback = await assessEssay(input, question, env, undefined, provider.fetch);
  assert.equal(feedback.holisticScore, 11);
  assert.equal(feedback.improvedEssay, needsWorkEssay);
  assert.equal(feedback.revisionAssessment?.status, "needs_work");
  assert.deepEqual(feedback.revisionAssessment?.scoringEvidence?.findings, [revisionGrammarFinding]);
  assert.equal(feedback.revisionAssessment?.assessmentFingerprint, await scoringFingerprint({ ...input, essay: needsWorkEssay }, question, env.DEEPSEEK_MODEL));
});

test("malformed revision data cannot mask an invalid original", async () => {
  const provider = syntheticProvider({ auditForAttempt: () => {
    const raw: any = audit(14);
    raw.original.findings = [];
    delete raw.revision;
    return raw;
  } });
  await assert.rejects(assessEssay(input, question, env, undefined, provider.fetch), (error: unknown) => error instanceof http.HttpError && error.code === "SCORING_INCONSISTENT");
  assert.equal(provider.trace.claimCalls, 0);
});

test("later rejected original claims invalidate recovery even when the revision remains malformed", async () => {
  let originalAudit = 0;
  const provider = syntheticProvider({
    auditForAttempt: () => {
      const raw: any = audit(14);
      delete raw.revision;
      return raw;
    },
    claimDecisions: decisions => {
      originalAudit++;
      return originalAudit === 1 ? decisions : decisions.map(d => ({ ...d, verdict: "invalid" }));
    },
    auditFailureForAttempt: attempt => attempt === 3 ? "timeout" : undefined,
  });
  await assert.rejects(assessEssay(input, question, env, undefined, provider.fetch), (error: unknown) => error instanceof http.HttpError);
  assert.equal(originalAudit, 2);
});

test("a partial optional improvement cannot replace an already complete verified report", async () => {
  const provider = syntheticProvider({
    editing: { ...candidate(), improvedEssay: needsWorkEssay },
    auditForAttempt: attempt => attempt === 1 ? needsWorkAudit() : audit(),
  });
  const feedback = await assessEssay(input, question, env, undefined, provider.fetch);
  assert.equal(feedback.improvedEssay, needsWorkEssay);
  assert.equal(feedback.revisionAssessment?.status, "needs_work");
  assert.equal(feedback.revisionAssessment?.holisticScore, 12);
  assert.deepEqual(feedback.revisionAssessment?.scoringEvidence?.findings, [revisionGrammarFinding]);
});

test("unscoped malformed claim decisions cannot authorize an original score", async () => {
  const provider = syntheticProvider({ auditForAttempt: () => audit(14), claimDecisions: decisions => [...decisions, null] });
  await assert.rejects(assessEssay(input, question, env, undefined, provider.fetch), (error: unknown) => error instanceof http.HttpError && error.code === "SCORING_INCONSISTENT");
});
