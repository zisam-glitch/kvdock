import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryAdapter } from "../adapters/memory/index.js";
import { CircuitBreakerOpenError } from "../core/errors.js";
import { KVDock } from "../core/store.js";
import type { ScanOptions, SetOptions, StorageAdapter } from "../core/types.js";
import {
  CircuitBreaker,
  type CircuitBreakerSnapshot,
  type CircuitBreakerState,
  withCircuitBreaker,
  withFailover,
} from "./circuit-breaker.js";

function createFaultyAdapter(options?: {
  failReads?: boolean;
  failWrites?: boolean;
  delayMs?: number;
}): StorageAdapter {
  const memory = new MemoryAdapter();
  return {
    name: "faulty-adapter",
    capabilities: { ...memory.capabilities },
    async get<T = unknown>(key: string): Promise<T | null> {
      if (options?.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
      if (options?.failReads) throw new Error("FaultyAdapter read connection dropped");
      return memory.get<T>(key);
    },
    async set<T = unknown>(key: string, value: T, opts?: SetOptions): Promise<void> {
      if (options?.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
      if (options?.failWrites) throw new Error("FaultyAdapter write connection dropped");
      return memory.set(key, value, opts);
    },
    async delete(key: string): Promise<boolean> {
      if (options?.failWrites) throw new Error("FaultyAdapter delete failed");
      return memory.delete(key);
    },
    async has(key: string): Promise<boolean> {
      if (options?.failReads) throw new Error("FaultyAdapter has failed");
      return memory.has(key);
    },
    async clear(): Promise<void> {
      if (options?.failWrites) throw new Error("FaultyAdapter clear failed");
      return memory.clear();
    },
    async keys(pattern?: string): Promise<string[]> {
      if (options?.failReads) throw new Error("FaultyAdapter keys failed");
      return memory.keys(pattern);
    },
    async getMany<T = unknown>(keys: string[]): Promise<Map<string, T | null>> {
      if (options?.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
      if (options?.failReads) throw new Error("FaultyAdapter getMany failed");
      return memory.getMany?.<T>(keys) ?? new Map();
    },
    async setMany<T = unknown>(
      entries: Array<{ key: string; value: T; options?: SetOptions }>,
    ): Promise<void> {
      if (options?.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
      if (options?.failWrites) throw new Error("FaultyAdapter setMany failed");
      await memory.setMany?.(entries);
    },
    async deleteMany(keys: string[]): Promise<number> {
      if (options?.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
      if (options?.failWrites) throw new Error("FaultyAdapter deleteMany failed");
      return (await memory.deleteMany?.(keys)) ?? 0;
    },
    async compareAndSwap<T = unknown>(
      key: string,
      expected: T | null,
      update: T,
      opts?: SetOptions,
    ): Promise<boolean> {
      if (options?.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
      if (options?.failWrites) throw new Error("FaultyAdapter CAS failed");
      return (await memory.compareAndSwap?.(key, expected, update, opts)) ?? false;
    },
    async *scan(pattern?: string, opts?: ScanOptions): AsyncIterable<string> {
      if (options?.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
      if (options?.failReads) throw new Error("FaultyAdapter scan failed");
      if (memory.scan) {
        yield* memory.scan(pattern, opts);
      }
    },
  };
}

describe("Circuit Breaker Middleware", () => {
  describe("CircuitBreaker State Machine", () => {
    it("starts in CLOSED state and executes successful calls", async () => {
      const breaker = new CircuitBreaker("test", { failureThreshold: 3 });
      expect(breaker.currentState).toBe("closed");
      expect(breaker.isClosed).toBe(true);
      expect(breaker.isOpen).toBe(false);

      const result = await breaker.execute(async () => 42);
      expect(result).toBe(42);

      const snapshot = breaker.getSnapshot();
      expect(snapshot.state).toBe("closed");
      expect(snapshot.successfulCalls).toBe(1);
      expect(snapshot.failedCalls).toBe(0);
      expect(snapshot.consecutiveSuccesses).toBe(1);
    });

    it("trips from CLOSED to OPEN after consecutive failures meet failureThreshold", async () => {
      const stateChanges: Array<{ from: CircuitBreakerState; to: CircuitBreakerState }> = [];
      const breaker = new CircuitBreaker("test", {
        failureThreshold: 3,
        resetTimeoutMs: 200,
        onStateChange: (from, to) => stateChanges.push({ from, to }),
      });

      for (let i = 0; i < 2; i++) {
        await expect(
          breaker.execute(async () => {
            throw new Error("fail");
          }),
        ).rejects.toThrow("fail");
        expect(breaker.currentState).toBe("closed");
      }

      await expect(
        breaker.execute(async () => {
          throw new Error("fail 3");
        }),
      ).rejects.toThrow("fail 3");
      expect(breaker.currentState).toBe("open");
      expect(breaker.isOpen).toBe(true);

      expect(stateChanges).toEqual([{ from: "closed", to: "open" }]);

      // Now immediate call should fail fast without running fn
      const fn = vi.fn();
      await expect(breaker.execute(fn)).rejects.toThrow(CircuitBreakerOpenError);
      expect(fn).not.toHaveBeenCalled();

      const snapshot = breaker.getSnapshot();
      expect(snapshot.rejectedCalls).toBe(1);
      expect(snapshot.failedCalls).toBe(3);
    });

    it("transitions to HALF_OPEN after resetTimeoutMs elapses and resets on consecutive probe successes", async () => {
      vi.useFakeTimers();
      try {
        const breaker = new CircuitBreaker("test", {
          failureThreshold: 2,
          resetTimeoutMs: 1000,
          consecutiveSuccessesNeeded: 2,
        });

        // Trip the breaker
        await expect(
          breaker.execute(async () => {
            throw new Error("f1");
          }),
        ).rejects.toThrow();
        await expect(
          breaker.execute(async () => {
            throw new Error("f2");
          }),
        ).rejects.toThrow();
        expect(breaker.currentState).toBe("open");

        // Advance clock past resetTimeoutMs
        vi.advanceTimersByTime(1001);
        expect(breaker.currentState).toBe("half_open");
        expect(breaker.isHalfOpen).toBe(true);

        // First successful probe
        await breaker.execute(async () => "probe-1");
        expect(breaker.currentState).toBe("half_open");

        // Second successful probe: should close!
        await breaker.execute(async () => "probe-2");
        expect(breaker.currentState).toBe("closed");
        expect(breaker.isClosed).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("re-trips to OPEN with exponential backoff if a probe fails during HALF_OPEN", async () => {
      vi.useFakeTimers();
      try {
        const breaker = new CircuitBreaker("test", {
          failureThreshold: 1,
          resetTimeoutMs: 1000,
          resetTimeoutBackoffFactor: 2,
          maxResetTimeoutMs: 5000,
        });

        await expect(
          breaker.execute(async () => {
            throw new Error("fail initial");
          }),
        ).rejects.toThrow();
        expect(breaker.currentState).toBe("open");

        // Advance 1000ms -> half_open
        vi.advanceTimersByTime(1001);
        expect(breaker.currentState).toBe("half_open");

        // Probe fails -> re-trips with backoff 2x (2000ms)
        await expect(
          breaker.execute(async () => {
            throw new Error("probe failed");
          }),
        ).rejects.toThrow();
        expect(breaker.currentState).toBe("open");

        // 1000ms later should still be open because timeout is now 2000ms
        vi.advanceTimersByTime(1100);
        expect(breaker.currentState).toBe("open");

        // Another 1000ms later -> half_open again
        vi.advanceTimersByTime(1000);
        expect(breaker.currentState).toBe("half_open");
      } finally {
        vi.useRealTimers();
      }
    });

    it("supports manual trip and reset", () => {
      const breaker = new CircuitBreaker("test");
      expect(breaker.isClosed).toBe(true);

      breaker.trip();
      expect(breaker.isOpen).toBe(true);

      breaker.reset();
      expect(breaker.isClosed).toBe(true);
    });

    it("evaluates sliding window failure rate threshold", async () => {
      const breaker = new CircuitBreaker("test", {
        failureThreshold: 0.5, // 50% failure rate
        slidingWindowSize: 6,
        minimumNumberOfCalls: 4,
      });

      // 2 successes, 2 failures -> 50% rate after 4 calls
      await breaker.execute(async () => "ok");
      await breaker.execute(async () => "ok");
      await expect(
        breaker.execute(async () => {
          throw new Error("err1");
        }),
      ).rejects.toThrow();
      expect(breaker.currentState).toBe("closed");

      await expect(
        breaker.execute(async () => {
          throw new Error("err2");
        }),
      ).rejects.toThrow();
      expect(breaker.currentState).toBe("open");
    });

    it("respects custom isFailure predicate", async () => {
      class BusinessValidationException extends Error {}

      const breaker = new CircuitBreaker("test", {
        failureThreshold: 2,
        isFailure: (err) => !(err instanceof BusinessValidationException),
      });

      // Business error should not count as failure
      await expect(
        breaker.execute(async () => {
          throw new BusinessValidationException("invalid param");
        }),
      ).rejects.toThrow();
      expect(breaker.getSnapshot().failedCalls).toBe(0);
      expect(breaker.currentState).toBe("closed");

      // Real system error counts
      await expect(
        breaker.execute(async () => {
          throw new Error("network drop");
        }),
      ).rejects.toThrow();
      expect(breaker.getSnapshot().failedCalls).toBe(1);
    });
  });

  describe("withCircuitBreaker Storage Adapter Wrapper", () => {
    it("wraps an adapter and executes CRUD operations normally when healthy", async () => {
      const memory = new MemoryAdapter();
      const breakerAdapter = withCircuitBreaker(memory, { failureThreshold: 3 });

      expect(breakerAdapter.name).toBe("circuit-breaker(memory)");
      expect(breakerAdapter.capabilities.ttl).toBe(true);

      await breakerAdapter.set("k1", "val1");
      expect(await breakerAdapter.get("k1")).toBe("val1");
      expect(await breakerAdapter.has("k1")).toBe(true);
      expect(await breakerAdapter.keys()).toEqual(["k1"]);

      expect(await breakerAdapter.delete("k1")).toBe(true);
      expect(await breakerAdapter.has("k1")).toBe(false);
    });

    it("transparently diverts to fallbackAdapter when primary adapter fails", async () => {
      const primary = createFaultyAdapter({ failReads: true, failWrites: true });
      const fallback = new MemoryAdapter();
      const fallbackCalls: string[] = [];

      const breakerAdapter = withCircuitBreaker(primary, {
        failureThreshold: 2,
        fallbackAdapter: fallback,
        onFallback: (op, key) => fallbackCalls.push(`${op}:${key}`),
      });

      // Set should fallback to fallback adapter
      await breakerAdapter.set("user:1", JSON.stringify({ name: "Alice" }));
      expect(fallbackCalls).toContain("set:user:1");

      // Get should read from fallback adapter
      const rawUser = await breakerAdapter.get<string>("user:1");
      expect(rawUser).not.toBeNull();
      expect(JSON.parse(rawUser ?? "{}")).toEqual({ name: "Alice" });
      expect(fallbackCalls).toContain("get:user:1");

      // Verify circuit breaker tripped
      expect(breakerAdapter.circuitBreaker.isOpen).toBe(true);
    });

    it("returns safe defaults when degradeGracefully is enabled and no fallbackAdapter is configured", async () => {
      const primary = createFaultyAdapter({ failReads: true, failWrites: true });
      const breakerAdapter = withCircuitBreaker(primary, {
        failureThreshold: 1,
        degradeGracefully: true,
      });

      // Initially set throws/trips breaker
      await breakerAdapter.set("k1", "v1");
      expect(breakerAdapter.circuitBreaker.isOpen).toBe(true);

      // Now reads return null without throwing CircuitBreakerOpenError!
      const val = await breakerAdapter.get("k1");
      expect(val).toBeNull();

      const has = await breakerAdapter.has("k1");
      expect(has).toBe(false);

      const keys = await breakerAdapter.keys();
      expect(keys).toEqual([]);
    });

    it("supports batch operations and compareAndSwap with fallback", async () => {
      const primary = createFaultyAdapter({ failReads: true, failWrites: true });
      const fallback = new MemoryAdapter();

      const breakerAdapter = withCircuitBreaker(primary, {
        failureThreshold: 1,
        fallbackAdapter: fallback,
      });

      await breakerAdapter.setMany?.([
        { key: "a", value: "1" },
        { key: "b", value: "2" },
      ]);

      const many = await breakerAdapter.getMany?.(["a", "b"]);
      expect(many?.get("a")).toBe("1");
      expect(many?.get("b")).toBe("2");

      const casOk = await breakerAdapter.compareAndSwap?.("a", "1", "99");
      expect(casOk).toBe(true);
      expect(await breakerAdapter.get("a")).toBe("99");

      const deleted = await breakerAdapter.deleteMany?.(["a", "b"]);
      expect(deleted).toBe(2);
    });

    it("works seamlessly inside KVDock store", async () => {
      const primary = createFaultyAdapter({ failReads: true, failWrites: true });
      const fallback = new MemoryAdapter();

      const adapter = withCircuitBreaker(primary, {
        failureThreshold: 1,
        fallbackAdapter: fallback,
      });

      const dock = new KVDock({ adapter });

      await dock.set("session:token", "xyz");
      const val = await dock.get("session:token");
      expect(val).toBe("xyz");
      expect(adapter.circuitBreaker.isOpen).toBe(true);

      await dock.close();
    });
  });

  describe("Active-Passive Failover Adapter (withFailover)", () => {
    it("routes requests to primary when healthy", async () => {
      const primary = new MemoryAdapter();
      const secondary = new MemoryAdapter();

      const failover = withFailover([primary, secondary]);
      expect(failover.activeIndex).toBe(0);
      expect(failover.stats.isPrimaryActive).toBe(true);

      await failover.set("key1", "val1");
      expect(await failover.get("key1")).toBe("val1");
      expect(await primary.get("key1")).toBe("val1");
      expect(await secondary.get("key1")).toBeNull();
    });

    it("automatically fails over to secondary on primary failure", async () => {
      const primary = createFaultyAdapter({ failReads: true, failWrites: true });
      const secondary = new MemoryAdapter();
      const events: string[] = [];

      const failover = withFailover([primary, secondary], {
        onFailover: (from, to) => events.push(`failover:${from}->${to}`),
      });

      await failover.set("key1", "val1");
      expect(failover.activeIndex).toBe(1);
      expect(failover.stats.isPrimaryActive).toBe(false);
      expect(events).toEqual(["failover:0->1"]);

      expect(await failover.get("key1")).toBe("val1");
      expect(await secondary.get("key1")).toBe("val1");
    });

    it("replicates writes to standby adapters when replicateWrites is true", async () => {
      const primary = new MemoryAdapter();
      const standby = new MemoryAdapter();

      const failover = withFailover([primary, standby], { replicateWrites: true });

      await failover.set("warm:key", "warm-value");
      expect(await primary.get("warm:key")).toBe("warm-value");
      expect(await standby.get("warm:key")).toBe("warm-value");

      await failover.delete("warm:key");
      expect(await primary.get("warm:key")).toBeNull();
      expect(await standby.get("warm:key")).toBeNull();
    });

    it("supports manual failover and failback", async () => {
      const primary = new MemoryAdapter();
      const secondary = new MemoryAdapter();

      const failover = withFailover([primary, secondary]);
      expect(failover.activeIndex).toBe(0);

      failover.failover(1);
      expect(failover.activeIndex).toBe(1);

      failover.failback();
      expect(failover.activeIndex).toBe(0);

      await failover.disconnect?.();
    });
  });
});
