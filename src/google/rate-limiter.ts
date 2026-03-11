import { RATE_LIMIT_WINDOW_MS } from "../constants";

export class RateLimitError extends Error {
  status: number;
  retryAfter: number;

  constructor(retryAfter: number) {
    super(`Rate limited. Retry after ${retryAfter}ms`);
    this.name = "RateLimitError";
    this.status = 429;
    this.retryAfter = retryAfter;
  }
}

export class CancellationError extends Error {
  constructor() {
    super("Request cancelled");
    this.name = "CancellationError";
  }
}

interface QueueEntry<T> {
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export class RateLimiter {
  private readonly maxRequestsPerMinute: number;
  private readonly windowMs: number;
  private readonly requestTimestamps: number[] = [];
  private readonly queue: QueueEntry<unknown>[] = [];
  private processing = false;
  private cancelled = false;
  private pendingDelays: Array<{
    timer: ReturnType<typeof setTimeout>;
    resolve: () => void;
  }> = [];

  constructor(maxRequestsPerMinute: number, windowMs: number = RATE_LIMIT_WINDOW_MS) {
    this.maxRequestsPerMinute = maxRequestsPerMinute;
    this.windowMs = windowMs;
  }

  execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.cancelled) {
      return Promise.reject(new CancellationError());
    }

    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        fn,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.processQueue().catch(() => {
        // Errors are already forwarded to individual entry.reject() handlers
      });
    });
  }

  cancel(): void {
    this.cancelled = true;

    for (const pending of this.pendingDelays) {
      clearTimeout(pending.timer);
      pending.resolve();
    }
    this.pendingDelays = [];

    const queued = this.queue.splice(0);
    for (const entry of queued) {
      entry.reject(new CancellationError());
    }
  }

  getPendingCount(): number {
    return this.queue.length;
  }

  private pruneTimestamps(now: number): void {
    const windowStart = now - this.windowMs;
    while (this.requestTimestamps.length > 0 && this.requestTimestamps[0] <= windowStart) {
      this.requestTimestamps.shift();
    }
  }

  private getDelayUntilSlotAvailable(now: number): number {
    this.pruneTimestamps(now);

    if (this.requestTimestamps.length < this.maxRequestsPerMinute) {
      return 0;
    }

    // The oldest timestamp in the window determines when a slot frees up
    const oldestInWindow = this.requestTimestamps[0];
    return oldestInWindow + this.windowMs - now;
  }

  private async processQueue(): Promise<void> {
    if (this.processing) {
      return;
    }

    this.processing = true;

    try {
      while (this.queue.length > 0 && !this.cancelled) {
        const now = Date.now();
        const delay = this.getDelayUntilSlotAvailable(now);

        if (delay > 0) {
          await this.delay(delay);
          if (this.cancelled) break;
          continue;
        }

        const entry = this.queue.shift();
        if (!entry) break;

        this.requestTimestamps.push(Date.now());

        try {
          const result = await entry.fn();
          entry.resolve(result);
        } catch (error: unknown) {
          if (this.isRateLimitError(error)) {
            const retryAfterMs = this.extractRetryAfter(error);
            await this.delay(retryAfterMs);
            if (this.cancelled) {
              entry.reject(new CancellationError());
              break;
            }
            // Re-record the timestamp for the retry
            this.requestTimestamps.push(Date.now());
            try {
              const result = await entry.fn();
              entry.resolve(result);
            } catch (retryError: unknown) {
              entry.reject(retryError);
            }
          } else {
            entry.reject(error);
          }
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const entry = {
        timer: setTimeout(() => {
          const idx = this.pendingDelays.indexOf(entry);
          if (idx >= 0) {
            this.pendingDelays.splice(idx, 1);
          }
          resolve();
        }, ms),
        resolve,
      };
      this.pendingDelays.push(entry);
    });
  }

  private isRateLimitError(error: unknown): boolean {
    if (error && typeof error === "object" && "status" in error) {
      return (error as { status: number }).status === 429;
    }
    return false;
  }

  private extractRetryAfter(error: unknown): number {
    if (
      error &&
      typeof error === "object" &&
      "retryAfter" in error &&
      typeof (error as { retryAfter: unknown }).retryAfter === "number"
    ) {
      return (error as { retryAfter: number }).retryAfter * 1000;
    }
    // Default backoff if no Retry-After provided
    return this.windowMs;
  }
}
