import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtempSync, openSync, ftruncateSync, closeSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staticAssets } from "../server/assets";
import { writingServer } from "../server/http-server";
import { sqliteDatabase } from "../server/database";
import { createSession } from "../worker/auth";
import type { Env } from "../worker/types";
import type { AiJobs } from "../src/lib/ai-jobs";

/** A real disconnected socket must cancel interactive work without waiting for the provider timeout. */
test("client disconnect aborts the interactive Request signal and releases its shared capacity", async t => {
  const local = sqliteDatabase(":memory:");
  const origin = "http://127.0.0.1:0";
  const env: Env = { DB: local.db, FREE_ACCESS_ENABLED: "true", MEMBERSHIP_ENABLED: "false", DEEPSEEK_API_KEY: "synthetic-not-a-real-key", ASSETS: { fetch: async () => new Response("asset") } };
  local.sql.prepare("INSERT INTO users(id,email,name,password,created_at) VALUES('learner','learner@example.test','Synthetic learner','!test',?)").run(new Date().toISOString());
  const cookie = (await createSession(new Request(origin), env, "learner")).split(";")[0];
  let active = 0;
  let started!: () => void; const sawStarted = new Promise<void>(resolve => { started = resolve; });
  let aborted!: () => void; const sawAborted = new Promise<void>(resolve => { aborted = resolve; });
  env.AI_JOBS = {
    policy: { concurrency: 3, maxPending: 30, maxWaitMs: 900000, runTimeoutMs: 240000 },
    enqueueReview: async () => { throw new Error("This fixture only exercises interactive cancellation"); },
    reviewInfo: () => undefined, isManaged: () => false,
    async runInteractive<T>(_owner: string, _operation: unknown, signal?: AbortSignal): Promise<T> {
      assert.ok(signal); active++; started();
      return new Promise<T>((_resolve, reject) => {
        const cancelled = () => { active--; aborted(); reject(signal.reason); };
        if (signal.aborted) cancelled(); else signal.addEventListener("abort", cancelled, { once: true });
      });
    },
  } as AiJobs;
  const server = writingServer(env, origin);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); local.sql.close(); });
  const port = (server.address() as { port: number }).port;
  const body = JSON.stringify({ messages: [{ role: "user", content: "Explain how to write an introduction." }] });
  const request = httpRequest({ hostname: "127.0.0.1", port, path: "/api/teacher", method: "POST", headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } });
  request.on("error", () => {});
  request.end(body);
  const deadline = (label: string) => new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error(label)), 1500); timer.unref(); });
  await Promise.race([sawStarted, deadline("Interactive work was not admitted")]);
  assert.equal(active, 1); request.destroy();
  await Promise.race([sawAborted, deadline("Disconnected client did not cancel Request.signal")]);
  assert.equal(active, 0);
});


/** Exercise the actual large-file stream through the HTTP adapter, including cancellation propagation. */
test("aborted installer downloads cancel the underlying file reader and leave later requests healthy", async t => {
  const directory = mkdtempSync(join(tmpdir(), "writing-download-abort-"));
  const file = join(directory, "synthetic-large.apk");
  const size = 64 * 1024 * 1024;
  const handle = openSync(file, "w"); ftruncateSync(handle, size); closeSync(handle);
  const assets = staticAssets(directory);
  const local = sqliteDatabase(":memory:");
  let cancellation!: () => void;
  const cancelled = new Promise<void>(resolve => { cancellation = resolve; });
  let readBytes = 0;
  const env = {
    DB: local.db, FREE_ACCESS_ENABLED: "true", MEMBERSHIP_ENABLED: "false",
    ASSETS: { async fetch(request: Request) {
      const response = await assets.fetch(request);
      if (!response.body) return response;
      const reader = response.body.getReader(); let stopped = false;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const result = await reader.read();
          if (stopped) return;
          if (result.done) controller.close(); else { readBytes += result.value.byteLength; controller.enqueue(result.value); }
        },
        async cancel(reason) { stopped = true; await reader.cancel(reason); cancellation(); },
      });
      return new Response(body, { status: response.status, headers: response.headers });
    } },
  } as Env;
  const server = writingServer(env, "http://127.0.0.1:0");
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); local.sql.close(); rmSync(directory, { recursive: true, force: true }); });
  const port = (server.address() as { port: number }).port;
  const request = httpRequest({ hostname: "127.0.0.1", port, path: "/synthetic-large.apk", method: "GET" }, response => {
    assert.equal(response.statusCode, 200); assert.equal(Number(response.headers["content-length"]), size);
    response.on("error", () => {});
    response.once("data", () => { response.destroy(); request.destroy(); });
  });
  request.on("error", () => {}); request.end();
  const deadline = new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error("The disconnected download did not cancel its file stream")), 3000); timer.unref(); });
  await Promise.race([cancelled, deadline]);
  assert.ok(readBytes > 0 && readBytes < size, `Expected an interrupted read, got ${readBytes} bytes`);
  const healthy = await fetch(`http://127.0.0.1:${port}/api/config`);
  assert.equal(healthy.status, 200); assert.ok((await healthy.json()).application);
  assert.equal(assets.cacheStats().bytes, 0);
});
