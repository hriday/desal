/** What one client message costs against its socket's bucket. */
export type Take = 'ok' | 'dropped' | 'abusive';

export interface BucketConfig {
  /** Tokens the bucket holds when full: the largest burst a socket may send. */
  burst: number;
  /** Tokens added per second. */
  refillPerS: number;
  /** A socket that keeps hitting an empty bucket for this long is abusive (the caller closes it). */
  abuseMs: number;
}

/**
 * A per-socket token bucket. Each message takes one token; an empty bucket drops the message
 * silently. A "streak" of drops starts with the first drop and ends once a full second passes
 * without one; a streak that lasts abuseMs makes the socket abusive.
 */
export class TokenBucket {
  private tokens: number;
  private at: number;
  private streakSince: number | null = null;
  private lastDrop = 0;

  constructor(
    private readonly cfg: BucketConfig,
    now: number,
  ) {
    this.tokens = cfg.burst;
    this.at = now;
  }

  take(now: number): Take {
    this.tokens = Math.min(this.cfg.burst, this.tokens + ((now - this.at) / 1000) * this.cfg.refillPerS);
    this.at = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 'ok';
    }
    if (this.streakSince === null || now - this.lastDrop > 1000) this.streakSince = now;
    this.lastDrop = now;
    return now - this.streakSince >= this.cfg.abuseMs ? 'abusive' : 'dropped';
  }
}
