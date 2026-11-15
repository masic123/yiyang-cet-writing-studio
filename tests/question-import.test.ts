import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { documentExtension, mineruPayload, questionImporter } from "../server/question-import";

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const pending = JSON.stringify({ parse: { status: "parsing" }, error: { code: "parse_wait_timeout" } });
const done = JSON.stringify({ parse: { status: "done" } });
function upload(name = "answer.png", type = "image/png") {
  const body = new FormData();
  body.set("file", new File([png], name, { type }));
  return new Request("https://example.test/api/answer-imports", { method: "POST", body });
}
async function temporaryRoot(t: test.TestContext) {
  const prefix = resolve(tmpdir(), "cet-ocr-test-");
  const root = await mkdtemp(prefix);
  t.after(async () => {
    assert.ok(root.startsWith(prefix));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
async function waitFor(importer: ReturnType<typeof questionImporter>, id: string, owner = "owner", timeout = 5000) {
  const deadline = Date.now() + timeout;
  let job;
  do {
    job = await importer.get(id, owner, "answer").json();
    if (job.status !== "processing") return job;
    await new Promise((r) => setTimeout(r, 10));
  } while (Date.now() < deadline);
  assert.fail("synthetic import did not finish");
}

test("MinerU bounded wait exit 1 stays pending; other failures cannot be mistaken for success", () => {
  assert.equal(mineruPayload(pending, 1).parse?.status, "parsing");
  assert.throws(() => mineruPayload(pending, 2), /parse_wait_timeout/);
  assert.throws(() => mineruPayload(JSON.stringify({ parse: { status: "parsing" }, error: { code: "invalid_api_key" } }), 1), /invalid_api_key/);
  assert.throws(() => mineruPayload(done, 1), /parse-command/);
  assert.throws(() => mineruPayload("not-json"), /parse-format/);
  assert.throws(() => mineruPayload("null"), /parse-format/);
});

test("importer continues a real execFile-style rejected bounded wait and cleans temporary files", async (t) => {
  const root = await temporaryRoot(t);
  let calls = 0;
  const importer = questionImporter("fake-mineru", root, async (_command, args) => {
    calls++;
    assert.ok(args[1].endsWith(".png"));
    if (calls === 1) throw Object.assign(new Error("Command failed"), { code: 1, stdout: pending });
    await writeFile(args[args.indexOf("--output") + 1], "Student is intrested in research.");
    return { stdout: done };
  });
  // Filename and MIME can be absent or misleading on phone uploads. Signature wins.
  const initial = await (await importer.start(upload("camera", ""), "owner", "answer")).json();
  assert.throws(() => importer.get(initial.id, "different-owner", "answer"), /未找到/);
  assert.throws(() => importer.get(initial.id, "owner", "question"), /未找到/);
  const result = await waitFor(importer, initial.id);
  assert.equal(result.status, "completed");
  assert.equal(result.text, "Student is intrested in research.");
  assert.equal(calls, 2);
  // Completion is visible just before finally removes files.
  for (let i = 0; i < 50 && (await readdir(join(root, "document-imports"))).length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(await readdir(join(root, "document-imports")), []);
});

test("simultaneous uploads cannot bypass global or per-account capacity", async (t) => {
  const root = await temporaryRoot(t);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const importer = questionImporter("fake-mineru", root, async (_command, args) => {
    await gate;
    await writeFile(args[args.indexOf("--output") + 1], "Synthetic answer.");
    return { stdout: done };
  });
  const starts = await Promise.allSettled(["a", "b", "c"].map((owner) => importer.start(upload(), owner, "answer")));
  assert.equal(starts.filter((r) => r.status === "fulfilled").length, 2);
  const rejected = starts.find((r) => r.status === "rejected");
  assert.ok(rejected?.status === "rejected" && /任务较多/.test(rejected.reason.message));
  release();
  for (let i = 0; i < starts.length; i++) {
    const result = starts[i];
    if (result.status === "fulfilled") await waitFor(importer, (await result.value.json()).id, ["a", "b", "c"][i]);
  }
  const same = await Promise.allSettled([importer.start(upload(), "same", "answer"), importer.start(upload(), "same", "answer")]);
  assert.equal(same.filter((r) => r.status === "fulfilled").length, 1);
  for (const result of same) if (result.status === "fulfilled") await waitFor(importer, (await result.value.json()).id, "same");
});

test("actual quota errors remain terminal with a safe public reason", async (t) => {
  const root = await temporaryRoot(t);
  const importer = questionImporter("fake-mineru", root, async () => {
    throw Object.assign(new Error("private service details"), { code: 1, stdout: JSON.stringify({ error: { code: "quota_exceeded", message: "private service details" } }) });
  });
  const initial = await (await importer.start(upload(), "owner", "answer")).json();
  const result = await waitFor(importer, initial.id);
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "quota_exceeded");
  assert.match(result.error, /额度/);
  assert.doesNotMatch(JSON.stringify(result), /private service details/);
});

test("format detection uses signatures and does not pretend HEIC is JPEG", () => {
  assert.equal(documentExtension(png), ".png");
  assert.equal(documentExtension(new Uint8Array([255, 216, 255, 0])), ".jpg");
  assert.equal(documentExtension(Buffer.from("0000ftypheic")), undefined);
});

const missingDoclib = () => Object.assign(new Error("private doclib details"), {
  code: 1, stdout: JSON.stringify({ error: { code: "server_not_running" } }),
});

test("two cold imports share one bounded doclib start and resume the same jobs", async (t) => {
  const root = await temporaryRoot(t);
  let running = false;
  let starts = 0;
  const importer = questionImporter("fake-mineru", root, async (_command, args, options) => {
    if (args[0] === "server") {
      starts++;
      assert.deepEqual(args, ["server", "start"]);
      assert.equal(options.windowsHide, true);
      assert.ok(Number(options.timeout) <= 45_000);
      await new Promise((r) => setTimeout(r, 25));
      running = true;
      return { stdout: "Server started." };
    }
    assert.equal(args[0], "parse");
    assert.ok(args.includes("--remote"));
    assert.ok(!args.includes("--force"));
    if (!running) throw missingDoclib();
    await writeFile(args[args.indexOf("--output") + 1], "Synthetic answer after cold start.");
    return { stdout: done };
  });
  const initial = await Promise.all(["cold-a", "cold-b"].map(async (owner) => ({ owner, job: await (await importer.start(upload(), owner, "answer")).json() })));
  for (const { owner, job } of initial) {
    const result = await waitFor(importer, job.id, owner);
    assert.equal(result.id, job.id);
    assert.equal(result.status, "completed");
  }
  assert.equal(starts, 1);
});

test("failed doclib startup ends clearly and its result is shared without exposing command details", async (t) => {
  const root = await temporaryRoot(t);
  let starts = 0;
  const importer = questionImporter("fake-mineru", root, async (_command, args) => {
    if (args[0] === "server") {
      starts++;
      throw new Error("private startup path and secret");
    }
    throw missingDoclib();
  });
  const initial = await Promise.all(["failed-a", "failed-b"].map(async (owner) => ({ owner, job: await (await importer.start(upload(), owner, "answer")).json() })));
  for (const { owner, job } of initial) {
    const result = await waitFor(importer, job.id, owner);
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "parse-service-start");
    assert.match(result.error, /未能启动.*稍后重试/);
    assert.doesNotMatch(JSON.stringify(result), /private|secret/);
  }
  assert.equal(starts, 1);
});

test("an unready doclib cannot cause endless server restarts", async (t) => {
  const root = await temporaryRoot(t);
  let starts = 0;
  let parses = 0;
  const importer = questionImporter("fake-mineru", root, async (_command, args) => {
    if (args[0] === "server") { starts++; return { stdout: "Server is still starting." }; }
    parses++;
    throw missingDoclib();
  });
  const initial = await (await importer.start(upload(), "owner", "answer")).json();
  const result = await waitFor(importer, initial.id, "owner", 20_000);
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "parse-service-unavailable");
  assert.match(result.error, /暂不可用.*稍后重试/);
  assert.equal(starts, 1);
  assert.ok(parses > 1 && parses <= 18);
});
