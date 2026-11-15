/** Public queue metadata contains no answer text, account details, or provider secrets. */
export type ReviewQueueInfo = {
  state: "queued" | "running" | "retrying";
  /** One means the next eligible waiting review. Zero means it is running. */
  position: number;
  attempt: number;
};

export interface AiJobs {
  readonly policy: {
    concurrency: number;
    maxPending: number;
    maxWaitMs: number;
    runTimeoutMs: number;
  };
  enqueueReview(owner: string, id: string): Promise<ReviewQueueInfo>;
  reviewInfo(id: string): ReviewQueueInfo | undefined;
  /** Includes terminal tombstones, which prevent interrupted submissions being replayed. */
  isManaged(id: string): boolean;
  runInteractive<T>(owner: string, operation: (signal: AbortSignal, stillOwned: () => boolean) => Promise<T>, signal?: AbortSignal): Promise<T>;
}
