import { beforeEach, describe, expect, it } from "vitest";
import { MemoryAdapter } from "../adapters/memory/index.js";
import { DistributedMutex, DistributedSemaphore } from "./lock.js";

describe("DistributedMutex & DistributedSemaphore", () => {
  let adapter: MemoryAdapter;
  let mutex: DistributedMutex;

  beforeEach(() => {
    adapter = new MemoryAdapter();
    mutex = new DistributedMutex(adapter, { leaseMs: 1000, retryIntervalMs: 10 });
  });

  describe("DistributedMutex", () => {
    it("acquires and releases a lock successfully", async () => {
      const handle = await mutex.acquire("resource-1");
      expect(handle).not.toBeNull();
      expect(handle?.key).toBe("resource-1");
      expect(handle?.fencingToken).toBeGreaterThan(0);

      // Concurrent acquire fails
      const conflict = await mutex.acquire("resource-1");
      expect(conflict).toBeNull();

      // Release allows re-acquire
      const released = await handle?.release();
      expect(released).toBe(true);

      const reacquired = await mutex.acquire("resource-1");
      expect(reacquired).not.toBeNull();
      expect(reacquired?.fencingToken).toBeGreaterThan(handle?.fencingToken);
      await reacquired?.release();
    });

    it("expires stale locks automatically", async () => {
      const handle = await mutex.acquire("temp-res", { leaseMs: 30 });
      expect(handle).not.toBeNull();

      await new Promise((resolve) => setTimeout(resolve, 50));

      const newHandle = await mutex.acquire("temp-res");
      expect(newHandle).not.toBeNull();
      await newHandle?.release();
    });

    it("extends an active lock lease", async () => {
      const handle = await mutex.acquire("ext-res", { leaseMs: 100 });
      expect(handle).not.toBeNull();
      const initialExpiry = handle?.expiresAt;

      await new Promise((resolve) => setTimeout(resolve, 20));
      const ok = await handle?.extend(300);
      expect(ok).toBe(true);
      expect(handle?.expiresAt).toBeGreaterThan(initialExpiry);
      await handle?.release();
    });

    it("runs critical section exclusively with runExclusive", async () => {
      let counter = 0;
      const worker = async () => {
        return mutex.runExclusive("counter-lock", async () => {
          const current = counter;
          await new Promise((resolve) => setTimeout(resolve, 15));
          counter = current + 1;
          return counter;
        });
      };

      await Promise.all([worker(), worker(), worker(), worker()]);
      expect(counter).toBe(4);
    });
  });

  describe("DistributedSemaphore", () => {
    it("limits concurrency to specified permits", async () => {
      const sem = new DistributedSemaphore(adapter, {
        permits: 2,
        leaseMs: 500,
        retryIntervalMs: 10,
      });

      const p1 = await sem.acquire("sem-test");
      const p2 = await sem.acquire("sem-test");
      expect(p1).not.toBeNull();
      expect(p2).not.toBeNull();

      // 3rd acquire fails because limit is 2
      const p3 = await sem.acquire("sem-test");
      expect(p3).toBeNull();

      // release p1
      await p1?.release();

      // now 3rd can acquire
      const p3Retry = await sem.acquire("sem-test");
      expect(p3Retry).not.toBeNull();

      await p2?.release();
      await p3Retry?.release();
    });

    it("safely runs parallel operations with runWithPermit", async () => {
      const sem = new DistributedSemaphore(adapter, {
        permits: 3,
        leaseMs: 500,
        retryIntervalMs: 10,
      });

      let activeCount = 0;
      let maxSeenActive = 0;

      const worker = async () => {
        return sem.runWithPermit("parallel-sem", async () => {
          activeCount++;
          maxSeenActive = Math.max(maxSeenActive, activeCount);
          await new Promise((r) => setTimeout(r, 20));
          activeCount--;
        });
      };

      await Promise.all(Array.from({ length: 6 }, () => worker()));
      expect(maxSeenActive).toBeLessThanOrEqual(3);
      expect(activeCount).toBe(0);
    });
  });
});
