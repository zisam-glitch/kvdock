import type { KVDock } from "../../core/store.js";

export interface RateLimitResult {
  /**
   * Whether the request is allowed through under the rate limit.
   */
  readonly allowed: boolean;

  /**
   * Number of remaining tokens or requests allowed in the current window.
   */
  readonly remaining: number;

  /**
   * Maximum capacity or request limit configured for this bucket.
   */
  readonly limit: number;

  /**
   * Milliseconds until the rate limit fully resets or replenishes.
   */
  readonly resetMs: number;
}

export interface TokenBucketOptions {
  /**
   * Target KVDock instance used for state persistence.
   */
  readonly dock: KVDock;

  /**
   * Maximum burst capacity of the token bucket.
   */
  readonly capacity: number;

  /**
   * Tokens replenished per second.
   */
  readonly refillRate: number;

  /**
   * Optional prefix for rate limiting keys.
   * @default "rl:tb"
   */
  readonly keyPrefix?: string;
}

interface StoredTokenBucket {
  tokens: number;
  lastRefill: number;
}

/**
 * Token Bucket Rate Limiter.
 * Allows bursts up to `capacity` while enforcing a smooth steady-state `refillRate` per second.
 */
export class TokenBucketLimiter {
  private readonly dock: KVDock;
  private readonly capacity: number;
  private readonly refillRate: number;
  private readonly keyPrefix: string;

  constructor(options: TokenBucketOptions) {
    if (options.capacity <= 0 || !Number.isFinite(options.capacity)) {
      throw new Error("capacity must be a positive finite number");
    }
    if (options.refillRate <= 0 || !Number.isFinite(options.refillRate)) {
      throw new Error("refillRate must be a positive finite number");
    }

    this.dock = options.dock;
    this.capacity = options.capacity;
    this.refillRate = options.refillRate;
    this.keyPrefix = options.keyPrefix ?? "rl:tb";
  }

  /**
   * Consumes tokens for a given identifier (e.g. IP address or API key).
   */
  async consume(key: string, tokens = 1): Promise<RateLimitResult> {
    const fullKey = `${this.keyPrefix}:${key}`;
    const now = Date.now();
    const maxTtlMs = Math.ceil((this.capacity / this.refillRate) * 1000) * 2;

    const maxRetries = 5;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const existing = await this.dock.get<StoredTokenBucket>(fullKey);
      const state = existing ?? {
        tokens: this.capacity,
        lastRefill: now,
      };

      // Calculate elapsed time and replenished tokens
      const elapsedMs = Math.max(0, now - state.lastRefill);
      const replenished = (elapsedMs / 1000) * this.refillRate;
      const currentTokens = Math.min(this.capacity, state.tokens + replenished);

      const allowed = currentTokens >= tokens;
      const newTokens = allowed ? currentTokens - tokens : currentTokens;

      const nextState: StoredTokenBucket = {
        tokens: newTokens,
        lastRefill: now,
      };

      // Try CAS update if available on the adapter, or fallback to direct set
      let success = false;
      try {
        success = await this.dock.compareAndSwap(fullKey, existing, nextState, { ttl: maxTtlMs });
      } catch {
        // If adapter does not support compareAndSwap, write directly
        await this.dock.set(fullKey, nextState, { ttl: maxTtlMs });
        success = true;
      }

      if (success) {
        const missingTokens = this.capacity - newTokens;
        const resetMs = Math.ceil((missingTokens / this.refillRate) * 1000);

        return {
          allowed,
          remaining: Math.floor(newTokens),
          limit: this.capacity,
          resetMs,
        };
      }
    }

    // High contention fallback: compute pessimistic result
    return {
      allowed: false,
      remaining: 0,
      limit: this.capacity,
      resetMs: 1000,
    };
  }

  /**
   * Resets rate limit state for a key.
   */
  async reset(key: string): Promise<void> {
    await this.dock.delete(`${this.keyPrefix}:${key}`);
  }
}

export interface SlidingWindowOptions {
  /**
   * Target KVDock instance used for state persistence.
   */
  readonly dock: KVDock;

  /**
   * Maximum allowed requests within the time window.
   */
  readonly limit: number;

  /**
   * Window duration in milliseconds.
   */
  readonly windowMs: number;

  /**
   * Optional prefix for rate limiting keys.
   * @default "rl:sw"
   */
  readonly keyPrefix?: string;
}

interface StoredSlidingWindow {
  prevCount: number;
  currentCount: number;
  currentWindowStart: number;
}

/**
 * Sliding Window Counter Rate Limiter.
 * Provides $O(1)$ memory usage and smooth boundaries using weighted sliding windows.
 */
export class SlidingWindowLimiter {
  private readonly dock: KVDock;
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly keyPrefix: string;

  constructor(options: SlidingWindowOptions) {
    if (options.limit <= 0 || !Number.isFinite(options.limit)) {
      throw new Error("limit must be a positive finite number");
    }
    if (options.windowMs <= 0 || !Number.isFinite(options.windowMs)) {
      throw new Error("windowMs must be a positive finite number");
    }

    this.dock = options.dock;
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.keyPrefix = options.keyPrefix ?? "rl:sw";
  }

  /**
   * Consumes request quota for a given identifier.
   */
  async consume(key: string, cost = 1): Promise<RateLimitResult> {
    const fullKey = `${this.keyPrefix}:${key}`;
    const now = Date.now();
    const currentWindowStart = Math.floor(now / this.windowMs) * this.windowMs;
    const ttlMs = this.windowMs * 2;

    const maxRetries = 5;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const existing = await this.dock.get<StoredSlidingWindow>(fullKey);
      const state = existing ?? {
        prevCount: 0,
        currentCount: 0,
        currentWindowStart,
      };

      let prevCount = state.prevCount;
      let currentCount = state.currentCount;

      if (currentWindowStart > state.currentWindowStart) {
        // Window shifted: previous becomes current if it's the immediately previous window
        const isImmediateNext = currentWindowStart - state.currentWindowStart === this.windowMs;
        prevCount = isImmediateNext ? state.currentCount : 0;
        currentCount = 0;
      }

      // Calculate weighted estimated count in the sliding window
      const elapsedInCurrent = now - currentWindowStart;
      const weight = Math.max(0, 1 - elapsedInCurrent / this.windowMs);
      const estimatedCount = prevCount * weight + currentCount;

      const allowed = estimatedCount + cost <= this.limit;
      const nextCount = allowed ? currentCount + cost : currentCount;

      const nextState: StoredSlidingWindow = {
        prevCount,
        currentCount: nextCount,
        currentWindowStart,
      };

      let success = false;
      try {
        success = await this.dock.compareAndSwap(fullKey, existing, nextState, { ttl: ttlMs });
      } catch {
        await this.dock.set(fullKey, nextState, { ttl: ttlMs });
        success = true;
      }

      if (success) {
        const totalUsed = allowed ? estimatedCount + cost : estimatedCount;
        const remaining = Math.max(0, Math.floor(this.limit - totalUsed));
        const resetMs = Math.max(0, this.windowMs - elapsedInCurrent);

        return {
          allowed,
          remaining,
          limit: this.limit,
          resetMs,
        };
      }
    }

    return {
      allowed: false,
      remaining: 0,
      limit: this.limit,
      resetMs: this.windowMs,
    };
  }

  /**
   * Resets rate limit state for a key.
   */
  async reset(key: string): Promise<void> {
    await this.dock.delete(`${this.keyPrefix}:${key}`);
  }
}
