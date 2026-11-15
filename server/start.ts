import { startMembershipJobs } from "../worker/membership";
import { dirname, resolve } from "node:path";
import { createReviewJobs } from "./review-jobs";
import { sqliteDatabase } from "./database";
import { staticAssets } from "./assets";
import { writingServer } from "./http-server";
import type { Env } from "../worker/types";
import { existsSync } from "node:fs";
import { questionImporter } from "./question-import";
import { loadShopConfiguration } from "./shop-payments";

process.umask(0o077);
const port = Number(process.env.PORT || 3002);
const origin = process.env.SITE_ORIGIN || `http://127.0.0.1:${port}`;
const { sql, db } = sqliteDatabase(
  resolve(process.env.DATABASE_PATH || "storage/cet-writing.sqlite"),
);
const identityPath = process.env.IDENTITY_DATABASE_PATH;
if (identityPath && !existsSync(identityPath)) throw new Error("Migrate the shared account database before enabling it");
const identity = identityPath ? sqliteDatabase(resolve(identityPath), { identityOnly: true }) : undefined;
const mineru = process.env.MINERU_COMMAND || "";
const env: Env = {
  DB: db,
  AUTH_DB: identity?.db,
  FREE_ACCESS_ENABLED: process.env.FREE_ACCESS_ENABLED || "true",
  ...loadShopConfiguration(origin),
  MEMBERSHIP_ENABLED: process.env.MEMBERSHIP_ENABLED || "true",
  MEMBERSHIP_REQUIRE_READY: "true",
  MEMBERSHIP_LAUNCH_DEFERRED: "false",
  MEMBERSHIP_LAUNCH_AT: "2026-11-02T00:00:00+08:00",
  MEMBERSHIP_SITE: "cet",
  MEMBERSHIP_BUY_URL: process.env.MEMBERSHIP_BUY_URL || "https://catfk.com/shop/8VID2BZD",
  ASSETS: staticAssets(resolve(process.env.ASSET_DIRECTORY || "out")),
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL,
  DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL,
  DEEPSEEK_VISION: process.env.DEEPSEEK_VISION,
  REGISTRATION_CODE: process.env.REGISTRATION_CODE,
  DAILY_REVIEW_LIMIT: process.env.DAILY_REVIEW_LIMIT,
  ...(process.env.MINERU_COMMAND || existsSync(mineru)
    ? { QUESTION_IMPORT: questionImporter(mineru, resolve("storage")) }
    : {}),
};
// Both containers already mount the same private identity directory. The queue is a separate database.
const sharedQueuePath = identityPath ? resolve(dirname(identityPath), "ai-jobs.sqlite") : undefined;
const queuePath = resolve(process.env.AI_QUEUE_DATABASE_PATH || sharedQueuePath || "storage/ai-jobs.sqlite");
if (sharedQueuePath && queuePath !== sharedQueuePath) throw new Error("Both shared-account sites must use the same separate AI queue database");
const reviewJobs = createReviewJobs(env, { path: queuePath, site: "cet" });
reviewJobs.start();
const stopMembershipJobs = startMembershipJobs(env);
const server = writingServer(env, origin, process.env.TRUST_PROXY === "true");
server.listen(port, process.env.HOST || "127.0.0.1", () =>
  console.log(`译洋 ready at ${origin}`),
);
let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopMembershipJobs();
    const closed = new Promise<void>(done => server.close(() => done()));
    // Stop admission and polling first, then drain/abort owned tasks before closing either database.
    void Promise.all([closed, reviewJobs.stop()]).then(() => {
      sql.close(); identity?.sql.close(); process.exit(0);
    }).catch(() => { console.error("Application shutdown did not complete cleanly"); process.exitCode = 1; });
  });
}
