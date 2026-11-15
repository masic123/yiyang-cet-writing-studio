import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staticAssets } from "../server/assets";

test("installer downloads preserve bytes, MIME, safe filenames and HEAD length", async () => {
  const root = await mkdtemp(join(tmpdir(), "yiyang-downloads-"));
  try {
    await mkdir(join(root, "downloads"));
    const assets = staticAssets(root);
    for (const [name, type] of [["client.apk", "application/vnd.android.package-archive"], ["client.exe", "application/octet-stream"]]) {
      const bytes = Buffer.from([0, 1, 127, 128, 254, 255]);
      await writeFile(join(root, "downloads", name), bytes);
      const url = "https://example.test/downloads/" + name;
      const response = await assets.fetch(new Request(url));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("Content-Type"), type);
      assert.equal(response.headers.get("Content-Disposition"), `attachment; filename="${name}"`);
      assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
      const head = await assets.fetch(new Request(url, { method: "HEAD" }));
      assert.equal(head.headers.get("Content-Length"), String(bytes.length));
      assert.equal((await head.arrayBuffer()).byteLength, 0);
      assert.equal((await assets.fetch(new Request(url, { method: "POST" }))).status, 405);
    }
    await writeFile(join(root, ".env"), "private");
    await writeFile(join(root, "private.sqlite"), "private");
    for (const path of ["/.env", "/downloads/%2e%2e%2f.env", "/downloads/%5cclient.exe", "/downloads/%00client.apk", "/private.sqlite"]) {
      assert.equal((await assets.fetch(new Request("https://example.test" + path))).status, 404);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
