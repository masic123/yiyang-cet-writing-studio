import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { staticAssets } from "../server/assets";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "assets-cache-test-"));
  const publicRoot = join(root, "public"); await mkdir(publicRoot);
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(join(tmpdir(), "assets-cache-test-"))));
    await rm(root, { recursive: true, force: true });
  });
  const write = async (path: string, data: string | Uint8Array) => {
    const parts = path.split("/"); const file = parts.pop()!;
    const directory = join(publicRoot, ...parts); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, file), data);
  };
  const request = (path: string, method = "GET") => new Request("https://example.test" + path, { method });
  return { root, publicRoot, write, request };
}

test("HTML burst loads are shared and cached for at most one second without changing response cache headers", async t => {
  const f = await fixture(t); let clock = 1000;
  await f.write("index.html", "first public page");
  const assets = staticAssets(f.publicRoot, { now: () => clock });
  const responses = Array.from({ length: 20 }, () => assets.fetch(f.request("/")));
  assert.equal(assets.cacheStats().inFlight, 1);
  for (const response of await Promise.all(responses)) {
    assert.equal(await response.text(), "first public page");
    assert.equal(response.headers.get("Cache-Control"), "no-cache");
  }
  assert.equal(assets.cacheStats().entries, 1); assert.equal(assets.cacheStats().inFlight, 0);
  await f.write("index.html", "replacement page");
  assert.equal(await (await assets.fetch(f.request("/"))).text(), "first public page");
  clock += 1001;
  assert.equal(await (await assets.fetch(f.request("/"))).text(), "replacement page");
});

test("manifest JSON always sees the next file version and hash assets refresh after their finite TTL", async t => {
  const f = await fixture(t); let clock = 1000;
  const assets = staticAssets(f.publicRoot, { now: () => clock });
  await f.write("downloads/manifest.json", '{"version":"one"}');
  assert.deepEqual(await (await assets.fetch(f.request("/downloads/manifest.json"))).json(), { version: "one" });
  await f.write("downloads/manifest.json", '{"version":"two"}');
  assert.deepEqual(await (await assets.fetch(f.request("/downloads/manifest.json"))).json(), { version: "two" });
  assert.equal(assets.cacheStats().entries, 0);
  const path = "/_next/static/chunks/abc12345.js";
  await f.write(path.slice(1), "first chunk");
  const first = await assets.fetch(f.request(path));
  assert.equal(first.headers.get("Cache-Control"), "public, max-age=31536000, immutable"); assert.equal(await first.text(), "first chunk");
  await f.write(path.slice(1), "new chunk");
  assert.equal(await (await assets.fetch(f.request(path))).text(), "first chunk");
  clock += 30_001;
  assert.equal(await (await assets.fetch(f.request(path))).text(), "new chunk");
});

test("cache byte and entry budgets use LRU, skip large files, and never cross site instances", async t => {
  const f = await fixture(t);
  const assets = staticAssets(f.publicRoot, { maxCacheBytes: 8, maxCacheEntries: 2, maxFileBytes: 4 });
  for (const name of ["aaaaaaaa", "bbbbbbbb", "cccccccc"]) await f.write("_next/static/" + name + ".js", name.slice(0, 4));
  const read = async (name: string) => (await assets.fetch(f.request("/_next/static/" + name + ".js"))).text();
  await read("aaaaaaaa"); await read("bbbbbbbb"); await read("aaaaaaaa"); await read("cccccccc");
  assert.equal(assets.cacheStats().entries, 2); assert.equal(assets.cacheStats().bytes, 8);
  const misses = assets.cacheStats().misses;
  await read("aaaaaaaa"); assert.equal(assets.cacheStats().misses, misses);
  await read("bbbbbbbb"); assert.equal(assets.cacheStats().misses, misses + 1);
  await f.write("_next/static/dddddddd.js", "too large to cache");
  assert.equal(await read("dddddddd"), "too large to cache");
  assert.equal(assets.cacheStats().entries, 2); assert.equal(assets.cacheStats().bytes, 8);
  const otherRoot = join(f.root, "other-public"); await mkdir(otherRoot); await writeFile(join(otherRoot, "index.html"), "other site");
  await f.write("index.html", "site");
  const independent = staticAssets(otherRoot);
  assert.equal(await (await independent.fetch(f.request("/"))).text(), "other site");
  assert.equal(await (await assets.fetch(f.request("/"))).text(), "site");
});

test("HEAD preserves byte length without a body and large responses stream identical bytes without caching", async t => {
  const f = await fixture(t);
  const bytes = Buffer.alloc(128 * 1024); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  await f.write("large.png", bytes); await f.write("index.html", "public page");
  const assets = staticAssets(f.publicRoot, { maxFileBytes: 16 });
  const head = await assets.fetch(f.request("/large.png", "HEAD"));
  assert.equal(head.headers.get("Content-Length"), String(bytes.length)); assert.equal((await head.arrayBuffer()).byteLength, 0);
  const response = await assets.fetch(f.request("/large.png"));
  const downloaded = new Uint8Array(await response.arrayBuffer());
  const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
  assert.equal(hash(downloaded), hash(bytes)); assert.equal(response.headers.get("Content-Length"), String(bytes.length));
  assert.equal(assets.cacheStats().entries, 0);
  await (await assets.fetch(f.request("/"))).text();
  const cachedHead = await assets.fetch(f.request("/", "HEAD"));
  assert.equal(cachedHead.headers.get("Content-Length"), String(Buffer.byteLength("public page"))); assert.equal((await cachedHead.arrayBuffer()).byteLength, 0);
  assert.equal(assets.cacheStats().entries, 1);
});

test("missing, private, encoded traversal, and outside symlink targets never enter the public cache", async t => {
  const f = await fixture(t);
  await f.write("private/secret.html", "never public");
  const outside = join(f.root, "outside"); await mkdir(outside); await writeFile(join(outside, "outside.html"), "outside content");
  await symlink(outside, join(f.publicRoot, "linked"), "junction");
  const assets = staticAssets(f.publicRoot);
  for (const path of ["/missing.html", "/private/secret.html", "/.env", "/%2e%2e%2foutside.html", "/%5csecret.html", "/linked/outside.html"]) {
    assert.equal((await assets.fetch(f.request(path))).status, 404, path);
  }
  assert.equal(assets.cacheStats().entries, 0); assert.equal(assets.cacheStats().bytes, 0);
  await f.write("missing.html", "now public");
  assert.equal(await (await assets.fetch(f.request("/missing.html"))).text(), "now public");
});
