import test from "node:test";
import assert from "node:assert/strict";
import { clientUpdate, compareClientVersions, installedClient } from "../src/lib/client-update";
test("release versions compare numerically and reject malformed values", () => {
  assert.equal(compareClientVersions("1.0.10", "1.0.9"), 1);
  assert.equal(compareClientVersions("1.0.2", "1.0.2"), 0);
  assert.equal(compareClientVersions("1.0.1", "1.0.2"), -1);
  for (const version of ["1.0", "1.0.2-beta", "1.0.2/../../evil", "1000000.1.0"]) assert.equal(compareClientVersions(version, "1.0.2"), null);
});
test("normal web visitors receive no client prompt; existing native clients are detected", () => {
  assert.equal(installedClient("Mozilla/5.0 Safari/604.1"), null);
  assert.deepEqual(installedClient("Mozilla/5.0 YiyangAndroid/1.0.1"), { platform: "android", version: "1.0.1" });
  assert.deepEqual(installedClient("Mozilla/5.0 YiyangWindows/1.0.0"), { platform: "windows", version: "1.0.0" });
});
test("updates require newer versions and a matching safe package filename and checksum", () => {
  const client = { platform: "android" as const, version: "1.0.1" };
  const release = { version: "1.0.2", file: "yiyang-1.0.2-android.apk", bytes: 50000, sha256: "a".repeat(64) };
  assert.deepEqual(clientUpdate(client, { android: release }), release);
  assert.equal(clientUpdate({ ...client, version: "1.0.2" }, { android: release }), null);
  assert.equal(clientUpdate({ ...client, version: "1.0.3" }, { android: release }), null);
  for (const row of [{ ...release, file: "https://untrusted.example/file.apk" }, { ...release, file: "../file.apk" }, { ...release, file: "yiyang-1.0.2-windows-x64-setup.exe" }, { ...release, bytes: -1 }, { ...release, sha256: "invalid" }]) assert.equal(clientUpdate(client, { android: row }), null);
});
