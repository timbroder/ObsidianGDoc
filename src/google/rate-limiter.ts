import { RATE_LIMIT_WINDOW_MS, MAX_RETRIES, RETRY_DELAYS_MS } from "../constants";

export class RateLimitError extends Error {
  status: number;
  /** Server-provided Retry-After in seconds, if any. */
  retryAfter?: number;

  constructor(retryAfter?: number) {
    super(
      retryAfter !== undefined
        ? `Rate limited. Retry after ${retryAfter}s`
        : "Rate limited.",
    );
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
    // Strictly older than the boundary: a timestamp at exactly
    // `now - windowMs` is still inside the [now - windowMs, now] window.
    while (this.requestTimestamps.length > 0 && this.requestTimestamps[0] < windowStart) {
      this.requestTimestamps.shift();
    }
  }

  private getDelayUntilSlotAvailable(now: number): number {
    this.pruneTimestamps(now);

    if (this.requestTimestamps.length < this.maxRequestsPerMinute) {
      return 0;
    }

    // The oldest timestamp in the window determines when a slot frees up.
    // A slot opens strictly AFTER the oldest timestamp leaves the inclusive
    // [now - windowMs, now] window, hence the +1.
    const oldestInWindow = this.requestTimestamps[0];
    return oldestInWindow + this.windowMs - now + 1;
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

        // One slot per logical request; retries do not consume extra slots.
        this.requestTimestamps.push(Date.now());

        await this.runWithRetries(entry);
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Execute an entry, retrying up to MAX_RETRIES times on 429 and 5xx
   * responses. 429s honor the server's Retry-After when provided; otherwise
   * the exponential RETRY_DELAYS_MS schedule applies.
   */
  private async runWithRetries(entry: QueueEntry<unknown>): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        entry.resolve(await entry.fn());
        return;
      } catch (error: unknown) {
        if (!this.isRetryableError(error) || attempt >= MAX_RETRIES) {
          entry.reject(error);
          return;
        }

        const delayMs = this.isRateLimitError(error)
          ? this.extractRetryAfter(error)
          : RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];

        await this.delay(delayMs);
        if (this.cancelled) {
          entry.reject(new CancellationError());
          return;
        }
      }
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

  private getErrorStatus(error: unknown): number | undefined {
    if (
      error &&
      typeof error === "object" &&
      "status" in error &&
      typeof (error as { status: unknown }).status === "number"
    ) {
      return (error as { status: number }).status;
    }
    return undefined;
  }

  private isRateLimitError(error: unknown): boolean {
    return this.getErrorStatus(error) === 429;
  }

  private isRetryableError(error: unknown): boolean {
    const status = this.getErrorStatus(error);
    return status === 429 || (status !== undefined && status >= 500 && status < 600);
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
