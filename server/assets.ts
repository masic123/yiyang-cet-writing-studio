import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { Readable } from "node:stream";

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".apk": "application/vnd.android.package-archive",
  ".exe": "application/octet-stream",
};

type AssetCacheOptions = {
  maxCacheBytes?: number;
  maxCacheEntries?: number;
  maxFileBytes?: number;
  htmlTtlMs?: number;
  staticTtlMs?: number;
  now?: () => number;
};
type CachedAsset = { actual: string; data: Uint8Array<ArrayBuffer>; expiresAt: number };

export function staticAssets(directory: string, options: AssetCacheOptions = {}) {
  const root = resolve(directory);
  const now = options.now ?? Date.now;
  const maxCacheBytes = Math.max(0, Math.min(options.maxCacheBytes ?? 8 * 1024 * 1024, 16 * 1024 * 1024));
  const maxCacheEntries = Math.max(0, Math.min(options.maxCacheEntries ?? 64, 128));
  const maxFileBytes = Math.max(0, Math.min(options.maxFileBytes ?? 1024 * 1024, maxCacheBytes));
  const htmlTtlMs = Math.max(0, Math.min(options.htmlTtlMs ?? 1000, 1000));
  const staticTtlMs = Math.max(0, Math.min(options.staticTtlMs ?? 30_000, 60_000));
  const cache = new Map<string, CachedAsset>();
  const inFlight = new Map<string, Promise<CachedAsset | undefined>>();
  let cachedBytes = 0, hits = 0, misses = 0;
  const forget = (key: string) => {
    const prior = cache.get(key);
    if (prior) cachedBytes -= prior.data.byteLength;
    cache.delete(key);
  };
  const ttlFor = (path: string, candidate: string) => {
    if (extname(candidate) === ".html") return htmlTtlMs;
    return path.startsWith("/_next/static/") && /[a-f0-9]{8,}/i.test(path) && [".js", ".css", ".woff", ".woff2"].includes(extname(candidate)) ? staticTtlMs : 0;
  };
  const remember = (key: string, asset: CachedAsset) => {
    if (!maxCacheEntries || asset.data.byteLength > maxFileBytes) return;
    forget(key);
    for (const [name, existing] of cache) if (existing.expiresAt <= now()) forget(name);
    while (cache.size >= maxCacheEntries || cachedBytes + asset.data.byteLength > maxCacheBytes) forget(cache.keys().next().value!);
    cache.set(key, asset); cachedBytes += asset.data.byteLength;
  };
  const headers = (path: string, actual: string, size: number) => {
    const installer = [".apk", ".exe"].includes(extname(actual));
    return {
      "Content-Type": mime[extname(actual)], "Content-Length": String(size), "X-Content-Type-Options": "nosniff",
      ...(installer ? { "Content-Disposition": `attachment; filename="${actual.split(sep).pop()!.replace(/[^A-Za-z0-9._-]/g, "_")}"` } : {}),
      "Cache-Control": path.startsWith("/_next/static/") ? "public, max-age=31536000, immutable" : "no-cache",
    };
  };
  async function load(candidate: string, ttl: number): Promise<CachedAsset | undefined> {
    const actual = await realpath(candidate);
    if (!actual.startsWith(root + sep)) return;
    const handle = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > maxFileBytes) return;
      const data = new Uint8Array(await handle.readFile());
      if (data.byteLength > maxFileBytes) return;
      const asset = { actual, data, expiresAt: now() + ttl };
      remember(candidate, asset);
      return asset;
    } finally { await handle.close(); }
  }
  return {
    cacheStats: () => ({ bytes: cachedBytes, entries: cache.size, inFlight: inFlight.size, hits, misses }),
    async fetch(request: Request): Promise<Response> {
      if (request.method !== "GET" && request.method !== "HEAD")
        return new Response(null, { status: 405 });
      let path: string;
      try {
        path = decodeURIComponent(new URL(request.url).pathname);
      } catch {
        return new Response(null, { status: 400 });
      }
      if (
        path.includes("\0") ||
        path.includes("\\") ||
        path.split("/").some((part) => part.startsWith(".") || ["private", "storage", "ops"].includes(part))
      ) {
        return new Response(null, { status: 404 });
      }
      const target = resolve(root, `.${path}`);
      if (target !== root && !target.startsWith(root + sep))
        return new Response(null, { status: 404 });
      for (const candidate of path.endsWith("/")
        ? [resolve(target, "index.html")]
        : [target, `${target}.html`]) {
        if (!mime[extname(candidate)]) continue;
        try {
          const ttl = ttlFor(path, candidate);
          if (ttl > 0 && maxFileBytes > 0) {
            const existing = cache.get(candidate);
            if (existing && existing.expiresAt > now()) {
              hits++; cache.delete(candidate); cache.set(candidate, existing);
              return new Response(request.method === "HEAD" ? null : existing.data, { headers: headers(path, existing.actual, existing.data.byteLength) });
            }
            if (existing) forget(candidate);
            if (request.method === "GET") {
              misses++;
              let pending = inFlight.get(candidate);
              if (!pending) {
                pending = load(candidate, ttl);
                if (inFlight.size < maxCacheEntries) {
                  inFlight.set(candidate, pending);
                  void pending.finally(() => { if (inFlight.get(candidate) === pending) inFlight.delete(candidate); }).catch(() => {});
                }
              }
              const loaded = await pending;
              if (loaded) return new Response(loaded.data, { headers: headers(path, loaded.actual, loaded.data.byteLength) });
            }
          }
          const actual = await realpath(candidate);
          if (!actual.startsWith(root + sep)) continue;
          const handle = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          try {
            const info = await handle.stat();
            if (!info.isFile()) { await handle.close(); continue; }
            if (request.method === "HEAD") { await handle.close(); return new Response(null, { headers: headers(path, actual, info.size) }); }
            // Downloads and large images never occupy the bounded cache or a full-file response buffer.
            const stream = Readable.toWeb(handle.createReadStream({ autoClose: true })) as ReadableStream<Uint8Array>;
            return new Response(stream, { headers: headers(path, actual, info.size) });
          } catch (error) { await handle.close(); throw error; }
        } catch {
          /* Missing files are ordinary 404s. */
        }
      }
      return new Response("Not found", { status: 404 });
    },
  };
}
