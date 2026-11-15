export type ClientPlatform = "android" | "windows";
export type InstalledClient = { platform: ClientPlatform; version: string };
export type ClientRelease = { version: string; file: string; bytes: number; sha256: string };
export const nativeUpdateVersion = "1.0.2";
export function compareClientVersions(left: string, right: string): number | null {
  if (![left, right].every(value => /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value))) return null;
  const a = left.split(".").map(Number), b = right.split(".").map(Number);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  return 0;
}
export function installedClient(agent: string): InstalledClient | null {
  const match = agent.match(/\bYiyang(Android|Windows)\/(\d{1,6}\.\d{1,6}\.\d{1,6})(?=\s|$)/);
  return match ? { platform: match[1] === "Android" ? "android" : "windows", version: match[2] } : null;
}
export function clientUpdate(client: InstalledClient, manifest: unknown): ClientRelease | null {
  if (!manifest || typeof manifest !== "object") return null;
  const release = (manifest as Record<string, unknown>)[client.platform];
  if (!release || typeof release !== "object") return null;
  const row = release as Record<string, unknown>;
  if (typeof row.version !== "string" || compareClientVersions(row.version, client.version) !== 1) return null;
  const suffix = client.platform === "android" ? "android.apk" : "windows-x64-setup.exe";
  if (row.file !== `yiyang-${row.version}-${suffix}` || typeof row.bytes !== "number" || !Number.isSafeInteger(row.bytes) || row.bytes <= 0 || row.bytes > 100_000_000 || typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.sha256)) return null;
  return row as ClientRelease;
}
