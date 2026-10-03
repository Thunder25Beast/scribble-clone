// Token bucket rate limiter. Each bucket refills at a fixed rate.
// Used for chat, drawing messages, join attempts, room creation.

export interface RateLimitConfig {
  tokens: number;     // max tokens (also the refill amount)
  intervalMs: number; // refill interval
}

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly intervalMs: number;

  constructor(config: RateLimitConfig) {
    this.maxTokens = config.tokens;
    this.intervalMs = config.intervalMs;
    this.tokens = config.tokens;
    this.lastRefill = Date.now();
  }

  // Try to consume one token. Returns true if allowed, false if rate limited.
  consume(count: number = 1): boolean {
    this.refill();
    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed >= this.intervalMs) {
      const refills = Math.floor(elapsed / this.intervalMs);
      this.tokens = Math.min(this.maxTokens, this.tokens + refills * this.maxTokens);
      this.lastRefill = now - (elapsed % this.intervalMs);
    }
  }
}

// Per-IP rate limiter store
export class IPRateLimiter {
  private buckets = new Map<string, TokenBucket>();
  private config: RateLimitConfig;

  constructor(config: RateLimitConfig) {
    this.config = config;
  }

  consume(ip: string): boolean {
    let bucket = this.buckets.get(ip);
    if (!bucket) {
      bucket = new TokenBucket(this.config);
      this.buckets.set(ip, bucket);
    }
    return bucket.consume();
  }

  // Cleanup old entries periodically
  cleanup(): void {
    // Simple: just clear everything. Buckets are cheap to recreate.
    if (this.buckets.size > 10000) {
      this.buckets.clear();
    }
  }
}
