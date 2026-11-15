import { createServer, type IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import worker from "../worker/index";
import type { Env } from "../worker/types";

function clientIP(request: IncomingMessage, trustProxy: boolean) {
  const peer = request.socket.remoteAddress || "127.0.0.1";
  const forwarded = request.headers["x-forwarded-for"];
  const candidate =
    typeof forwarded === "string" ? forwarded.split(",").at(-1)?.trim() : "";
  // The app port is only exposed on a private Docker network behind Caddy.
  return trustProxy && candidate && isIP(candidate) ? candidate : peer;
}

export function writingServer(
  env: Env,
  siteOrigin: string,
  trustProxy = false,
) {
  const origin = new URL(siteOrigin);
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new Error("SITE_ORIGIN must be an http(s) origin");
  }
  const server = createServer(async (incoming, outgoing) => {
    try {
      const host = incoming.headers.host;
      if (
        host !== origin.host &&
        !/^localhost:\d+$/.test(host || "") &&
        !/^127\.0\.0\.1:\d+$/.test(host || "")
      ) {
        outgoing.writeHead(421).end();
        return;
      }
      const target = incoming.url || "/";
      if (!target.startsWith("/") || target.startsWith("//")) {
        outgoing.writeHead(400).end();
        return;
      }
      const maxBody = ["/api/question-imports", "/api/answer-imports"].includes(
        target.split("?")[0],
      )
        ? 10_500_000
        : 1_700_000;
      if (Number(incoming.headers["content-length"]) > maxBody) {
        outgoing.writeHead(413).end();
        return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (
          value &&
          ![
            "host",
            "connection",
            "transfer-encoding",
            "cf-connecting-ip",
            "x-forwarded-for",
            "x-forwarded-proto",
          ].includes(name)
        ) {
          headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
      }
      headers.set("CF-Connecting-IP", clientIP(incoming, trustProxy));
      const method = incoming.method || "GET";
      const controller = new AbortController();
      const abortRequest = () => controller.abort(new DOMException("Client disconnected", "AbortError"));
      const cleanup = () => {
        incoming.off("aborted", abortRequest);
        outgoing.off("close", onClose);
        outgoing.off("finish", cleanup);
      };
      const onClose = () => {
        if (!outgoing.writableEnded) abortRequest();
        cleanup();
      };
      incoming.once("aborted", abortRequest);
      outgoing.once("close", onClose);
      outgoing.once("finish", cleanup);
      const init: RequestInit & { duplex?: string } = { method, headers, signal: controller.signal };
      if (method !== "GET" && method !== "HEAD") {
        init.body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
        init.duplex = "half";
      }
      const request = new Request(origin.origin + target, init);
      const response = await worker.fetch(request, env);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (method === "HEAD" || !response.body) outgoing.end();
      else await pipeline(Readable.fromWeb(response.body as never), outgoing, { signal: controller.signal });
    } catch (error) {
      if (outgoing.destroyed || outgoing.writableEnded) return;
      // Never log request bodies, authentication headers, or provider secrets.
      console.error(
        "HTTP adapter:",
        error instanceof Error ? error.name : "UnknownError",
      );
      if (outgoing.headersSent) { outgoing.destroy(); return; }
      if (!outgoing.headersSent)
        outgoing.writeHead(500, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
      outgoing.end(JSON.stringify({ error: "暂时无法完成操作，请稍后重试。" }));
    }
  });
  server.requestTimeout = 180_000;
  server.headersTimeout = 20_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
