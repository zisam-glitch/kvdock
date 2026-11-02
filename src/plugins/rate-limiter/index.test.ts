import { describe, expect, it } from "vitest";
import { MemoryAdapter } from "../../adapters/memory/index.js";
import { KVDock } from "../../core/store.js";
import { SlidingWindowLimiter, TokenBucketLimiter } from "./index.js";

describe("Rate Limiter Plugin", () => {
  describe("TokenBucketLimiter", () => {
    it("allows requests up to capacity and rejects subsequent requests", async () => {
      const memory = new MemoryAdapter();
      const dock = new KVDock({ adapter: memory });
      const limiter = new TokenBucketLimiter({
        dock,
        capacity: 3,
        refillRate: 1, // 1 token per second
      });

      // 3 allowed
      const r1 = await limiter.consume("user-1");
      expect(r1.allowed).toBe(true);
      expect(r1.remaining).toBe(2);

      const r2 = await limiter.consume("user-1");
      expect(r2.allowed).toBe(true);
      expect(r2.remaining).toBe(1);

      const r3 = await limiter.consume("user-1");
      expect(r3.allowed).toBe(true);
      expect(r3.remaining).toBe(0);

      // 4th is rejected
      const r4 = await limiter.consume("user-1");
      expect(r4.allowed).toBe(false);
      expect(r4.remaining).toBe(0);
      expect(r4.resetMs).toBeGreaterThan(0);
    });

    it("resets rate limit for a key", async () => {
      const memory = new MemoryAdapter();
      const dock = new KVDock({ adapter: memory });
      const limiter = new TokenBucketLimiter({
        dock,
        capacity: 1,
        refillRate: 1,
      });

      expect((await limiter.consume("user-2")).allowed).toBe(true);
      expect((await limiter.consume("user-2")).allowed).toBe(false);

      await limiter.reset("user-2");
      expect((await limiter.consume("user-2")).allowed).toBe(true);
    });

    it("throws on invalid capacity or refillRate", () => {
      const dock = new KVDock({ adapter: new MemoryAdapter() });
      expect(() => new TokenBucketLimiter({ dock, capacity: -1, refillRate: 1 })).toThrow();
      expect(() => new TokenBucketLimiter({ dock, capacity: 5, refillRate: 0 })).toThrow();
    });
  });

  describe("SlidingWindowLimiter", () => {
    it("allows up to limit within the window", async () => {
      const memory = new MemoryAdapter();
      const dock = new KVDock({ adapter: memory });
      const limiter = new SlidingWindowLimiter({
        dock,
        limit: 5,
        windowMs: 60_000,
      });

      for (let i = 0; i < 5; i++) {
        const result = await limiter.consume("client-ip-1");
        expect(result.allowed).toBe(true);
      }

      // 6th call exceeded
      const exceeded = await limiter.consume("client-ip-1");
      expect(exceeded.allowed).toBe(false);
      expect(exceeded.remaining).toBe(0);
      expect(exceeded.resetMs).toBeGreaterThan(0);
    });

    it("tracks different keys independently", async () => {
      const memory = new MemoryAdapter();
      const dock = new KVDock({ adapter: memory });
      const limiter = new SlidingWindowLimiter({
        dock,
        limit: 1,
        windowMs: 10_000,
      });

      expect((await limiter.consume("key-a")).allowed).toBe(true);
      expect((await limiter.consume("key-a")).allowed).toBe(false);

      expect((await limiter.consume("key-b")).allowed).toBe(true);
    });

    it("throws on invalid limit or windowMs", () => {
      const dock = new KVDock({ adapter: new MemoryAdapter() });
      expect(() => new SlidingWindowLimiter({ dock, limit: 0, windowMs: 1000 })).toThrow();
      expect(() => new SlidingWindowLimiter({ dock, limit: 10, windowMs: -50 })).toThrow();
    });
  });
});
