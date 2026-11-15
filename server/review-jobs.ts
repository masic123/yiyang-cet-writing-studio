import { createAiJobs, type AiJobOptions } from "./ai-jobs";
import { getReview, finishReview } from "../worker/repository";
import { assessEssayForOwner } from "../src/lib/reviewer";
import { abortableFetch, fencedDatabase } from "../worker/ai-capacity";
import { HttpError } from "../src/lib/http";
import type { Env } from "../worker/types";
import type { Review, Feedback } from "../src/lib/types";

type RuntimeOptions = {
  path: string;
  site: string;
  assess?: (review: Review, owner: string, providerFetch: typeof fetch) => Promise<Feedback>;
  scheduler?: AiJobOptions;
};
/** Keep essays in the site database; the shared queue contains only task references. */
export function createReviewJobs(env: Env, options: RuntimeOptions) {
  const runtime = createAiJobs({
    options: options.scheduler,
    path: options.path,
    site: options.site,
    async executeReview(owner, id, signal, stillOwned) {
      const review = await getReview(env, owner, id);
      if (review.status !== "processing") return;
      const providerFetch = abortableFetch(signal, stillOwned);
      const feedback = options.assess ? await options.assess(review, owner, providerFetch) : await assessEssayForOwner(review.input, review.question, env, owner, providerFetch);
      const guard = () => !signal.aborted && stillOwned();
      if (!guard()) throw new HttpError(503, "批改执行已中止，作答已保留。", "AI_JOB_CANCELLED");
      await finishReview({ ...env, DB: fencedDatabase(env.DB, guard) }, owner, id, feedback);
    },
    async failReview(owner, id, message) {
      const review = await getReview(env, owner, id);
      if (review.status === "processing") await finishReview(env, owner, id, null, message);
    },
    async recoverReviews() {
      const cutoff = new Date(Date.now() - 5000).toISOString();
      return (await env.DB.prepare("SELECT id,user_id,created_at FROM reviews WHERE status='processing' AND created_at<? ORDER BY created_at LIMIT 100")
        .bind(cutoff).all<{ id: string; user_id: string; created_at: string }>()).results
        .map(row => ({ id: row.id, owner: row.user_id, createdAt: row.created_at }));
    },
  });
  env.AI_JOBS = runtime.jobs;
  return runtime;
}
