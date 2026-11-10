import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryAdapter } from "../adapters/memory/index.js";
import { KVDock } from "../core/store.js";
import type { StorageAdapter } from "../core/types.js";
import {
  type BackoffOptions,
  RetryExhaustedError,
  RetryMiddleware,
  calculateBackoffDelay,
  isRetryableError,
  retry,
  withRetry,
} from "./retry.js";

describe("Retry Middleware", () => {
  describe("calculateBackoffDelay", () => {
    it("calculates deterministic exponential backoff when jitter is none", () => {
      const opts: BackoffOptions = {
        initialDelayMs: 100,
        backoffFactor: 2,
        maxDelayMs: 2000,
        jitter: "none",
      };

      expect(calculateBackoffDelay(1, opts)).toBe(100);
      expect(calculateBackoffDelay(2, opts)).toBe(200);
      expect(calculateBackoffDelay(3, opts)).toBe(400);
      expect(calculateBackoffDelay(4, opts)).toBe(800);
      expect(calculateBackoffDelay(5, opts)).toBe(1600);
      expect(calculateBackoffDelay(6, opts)).toBe(2000); // capped at maxDelayMs
    });

    it("handles jitter: false as none", () => {
      const opts: BackoffOptions = {
        initialDelayMs: 50,
        backoffFactor: 3,
        jitter: false,
      };

      expect(calculateBackoffDelay(1, opts)).toBe(50);
      expect(calculateBackoffDelay(2, opts)).toBe(150);
      expect(calculateBackoffDelay(3, opts)).toBe(450);
    });

    it("applies full jitter uniformly within [0, rawDelay]", () => {
      const optsMin: BackoffOptions = {
        initialDelayMs: 200,
        jitter: "full",
        randomFn: () => 0,
      };
      expect(calculateBackoffDelay(1, optsMin)).toBe(0);

      const optsHalf: BackoffOptions = {
        initialDelayMs: 200,
        jitter: "full",
        randomFn: () => 0.5,
      };
      expect(calculateBackoffDelay(1, optsHalf)).toBe(100);

      const optsMax: BackoffOptions = {
        initialDelayMs: 200,
        jitter: "full",
        randomFn: () => 1.0,
      };
      expect(calculateBackoffDelay(1, optsMax)).toBe(200);
    });

    it("applies equal jitter within [rawDelay / 2, rawDelay]", () => {
      const optsMin: BackoffOptions = {
        initialDelayMs: 400,
        jitter: "equal",
        randomFn: () => 0,
      };
      expect(calculateBackoffDelay(1, optsMin)).toBe(200);

      const optsMax: BackoffOptions = {
        initialDelayMs: 400,
        jitter: "equal",
        randomFn: () => 1,
      };
      expect(calculateBackoffDelay(1, optsMax)).toBe(400);
    });

    it("applies decorrelated jitter bounded by initialDelayMs and previousDelayMs", () => {
      const opts: BackoffOptions = {
        initialDelayMs: 100,
        maxDelayMs: 2000,
        jitter: "decorrelated",
        randomFn: () => 0.5,
      };

      // When prev is 100, ceiling is 300, range is 200, half is 100 + 100 = 200
      const delay1 = calculateBackoffDelay(1, opts, 100);
      expect(delay1).toBe(200);

      // When prev is 500, ceiling is 1500, range is 1400, half is 100 + 700 = 800
      const delay2 = calculateBackoffDelay(2, opts, 500);
      expect(delay2).toBe(800);
    });
  });

  describe("isRetryableError", () => {
    it("identifies network error codes as retryable", () => {
      expect(isRetryableError({ code: "ECONNRESET" })).toBe(true);
      expect(isRetryableError({ code: "ETIMEDOUT" })).toBe(true);
      expect(isRetryableError({ code: "ECONNREFUSED" })).toBe(true);
      expect(isRetryableError({ code: "EAI_AGAIN" })).toBe(true);
      expect(isRetryableError({ code: "ERR_CONNECTION" })).toBe(true);
    });

    it("identifies HTTP transient status codes as retryable", () => {
      expect(isRetryableError({ status: 429 })).toBe(true);
      expect(isRetryableError({ statusCode: 503 })).toBe(true);
      expect(isRetryableError({ statusCode: 500 })).toBe(true);
      expect(isRetryableError({ status: 502 })).toBe(true);
      expect(isRetryableError({ status: 404 })).toBe(false);
      expect(isRetryableError({ status: 400 })).toBe(false);
    });

    it("identifies timeout and connection error messages", () => {
      expect(isRetryableError(new Error("socket hang up"))).toBe(true);
      expect(isRetryableError(new Error("operation timed out"))).toBe(true);
      expect(isRetryableError(new Error("rate limit exceeded"))).toBe(true);
      expect(isRetryableError(new Error("connection reset by peer"))).toBe(true);
      expect(isRetryableError(new Error("Service Temporarily Unavailable"))).toBe(true);
      expect(isRetryableError(new Error("syntax error in query"))).toBe(false);
    });

    it("respects explicit retryable boolean property", () => {
      expect(isRetryableError({ retryable: true, message: "custom failure" })).toBe(true);
      expect(isRetryableError({ retryable: false, code: "ECONNRESET" })).toBe(false);
    });

    it("treats TTLValidationError, SerializationError, and AbortError as non-retryable", () => {
      const ttlErr = new Error("invalid ttl");
      ttlErr.name = "TTLValidationError";
      expect(isRetryableError(ttlErr)).toBe(false);

      const serErr = new Error("cannot serialize");
      serErr.name = "SerializationError";
      expect(isRetryableError(serErr)).toBe(false);

      const abortErr = new Error("aborted");
      abortErr.name = "AbortError";
      expect(isRetryableError(abortErr)).toBe(false);
    });
  });

  describe("retry() core function", () => {
    it("returns immediately without retrying on success", async () => {
      const fn = vi.fn().mockResolvedValue("hello");
      const onRetry = vi.fn();

      const result = await retry(fn, { onRetry });

      expect(result).toBe("hello");
      expect(fn).toHaveBeenCalledTimes(1);
      expect(onRetry).not.toHaveBeenCalled();
    });

    it("retries on transient failure and resolves when succeeded", async () => {
      let attempts = 0;
      const fn = vi.fn().mockImplementation(async () => {
        attempts++;
        if (attempts < 3) {
          const err = new Error("ETIMEDOUT");
          (err as { code: string }).code = "ETIMEDOUT";
          throw err;
        }
        return "success-after-retry";
      });

      const onRetry = vi.fn();
      const sleepFn = vi.fn().mockResolvedValue(undefined);

      const result = await retry(fn, {
        maxRetries: 3,
        initialDelayMs: 10,
        sleepFn,
        onRetry,
      });

      expect(result).toBe("success-after-retry");
      expect(fn).toHaveBeenCalledTimes(3);
      expect(onRetry).toHaveBeenCalledTimes(2);
      expect(sleepFn).toHaveBeenCalledTimes(2);
      expect(onRetry).toHaveBeenNthCalledWith(1, expect.objectContaining({ attempt: 1 }));
      expect(onRetry).toHaveBeenNthCalledWith(2, expect.objectContaining({ attempt: 2 }));
    });

    it("fails fast on non-retryable error without retrying", async () => {
      const nonRetryable = new Error("fatal schema mismatch");
      const fn = vi.fn().mockRejectedValue(nonRetryable);
      const onRetry = vi.fn();

      await expect(retry(fn, { maxRetries: 5, onRetry })).rejects.toThrow("fatal schema mismatch");
      expect(fn).toHaveBeenCalledTimes(1);
      expect(onRetry).not.toHaveBeenCalled();
    });

    it("throws RetryExhaustedError when maxRetries is exceeded", async () => {
      const transientErr = new Error("connection reset");
      (transientErr as { code: string }).code = "ECONNRESET";
      const fn = vi.fn().mockRejectedValue(transientErr);
      const sleepFn = vi.fn().mockResolvedValue(undefined);
      const onRetry = vi.fn();

      await expect(
        retry(fn, { maxRetries: 2, sleepFn, onRetry }, { operation: "get", key: "user:123" }),
      ).rejects.toThrowError(RetryExhaustedError);

      expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
      expect(onRetry).toHaveBeenCalledTimes(2);
    });

    it("aborts promptly when AbortSignal is triggered", async () => {
      const controller = new AbortController();
      controller.abort(new Error("Operation cancelled by user"));

      const fn = vi.fn().mockResolvedValue("never");

      await expect(retry(fn, { signal: controller.signal })).rejects.toThrow(
        "Operation cancelled by user",
      );
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe("withRetry & StorageAdapter wrapping", () => {
    let memory: MemoryAdapter;

    beforeEach(() => {
      memory = new MemoryAdapter();
    });

    it("wraps an adapter and preserves capabilities and name suffix", () => {
      const wrapped = withRetry(memory);
      expect(wrapped.name).toBe("memory:retry");
      expect(wrapped.capabilities).toEqual(memory.capabilities);
    });

    it("successfully retries flaky get and set calls", async () => {
      let getFailures = 2;
      const failingAdapter: StorageAdapter = {
        name: "flaky-db",
        capabilities: { ...memory.capabilities },
        get: vi.fn().mockImplementation(async (key: string) => {
          if (getFailures > 0) {
            getFailures--;
            const err = new Error("read timed out");
            (err as { code: string }).code = "ETIMEDOUT";
            throw err;
          }
          return memory.get(key);
        }),
        set: vi.fn().mockImplementation(async (key, val, opts) => {
          return memory.set(key, val, opts);
        }),
        delete: (k) => memory.delete(k),
        has: (k) => memory.has(k),
        clear: () => memory.clear(),
        keys: (p) => memory.keys(p),
      };

      await memory.set("test-key", "test-val");

      const onRetry = vi.fn();
      const wrapped = withRetry(failingAdapter, {
        maxRetries: 3,
        initialDelayMs: 5,
        sleepFn: vi.fn().mockResolvedValue(undefined),
        onRetry,
      });

      const value = await wrapped.get("test-key");
      expect(value).toBe("test-val");
      expect(failingAdapter.get).toHaveBeenCalledTimes(3);
      expect(onRetry).toHaveBeenCalledTimes(2);
    });

    it("respects idempotentOnly option", async () => {
      const failingAdapter: StorageAdapter = {
        name: "flaky-db",
        capabilities: { ...memory.capabilities },
        get: vi.fn().mockRejectedValue({ code: "ECONNRESET" }),
        set: vi.fn().mockRejectedValue({ code: "ECONNRESET" }),
        delete: vi.fn().mockRejectedValue({ code: "ECONNRESET" }),
        has: (k) => memory.has(k),
        clear: () => memory.clear(),
        keys: (p) => memory.keys(p),
      };

      const wrapped = withRetry(failingAdapter, {
        idempotentOnly: true,
        maxRetries: 2,
        sleepFn: vi.fn().mockResolvedValue(undefined),
      });

      // Idempotent "get" retries and exhausts
      await expect(wrapped.get("k")).rejects.toThrow(RetryExhaustedError);
      expect(failingAdapter.get).toHaveBeenCalledTimes(3);

      // Non-idempotent "set" fails fast on attempt 1 without retry
      await expect(wrapped.set("k", "v")).rejects.toEqual({ code: "ECONNRESET" });
      expect(failingAdapter.set).toHaveBeenCalledTimes(1);
    });

    it("respects explicit operations whitelist", async () => {
      const failingAdapter: StorageAdapter = {
        name: "flaky-db",
        capabilities: { ...memory.capabilities },
        get: vi.fn().mockRejectedValue({ code: "ECONNRESET" }),
        delete: vi.fn().mockRejectedValue({ code: "ECONNRESET" }),
        set: (k, v, o) => memory.set(k, v, o),
        has: (k) => memory.has(k),
        clear: () => memory.clear(),
        keys: (p) => memory.keys(p),
      };

      const wrapped = withRetry(failingAdapter, {
        operations: ["get"],
        maxRetries: 2,
        sleepFn: vi.fn().mockResolvedValue(undefined),
      });

      // get is in whitelist -> retries
      await expect(wrapped.get("k")).rejects.toThrow(RetryExhaustedError);
      expect(failingAdapter.get).toHaveBeenCalledTimes(3);

      // delete is NOT in whitelist -> fails fast immediately
      await expect(wrapped.delete("k")).rejects.toEqual({ code: "ECONNRESET" });
      expect(failingAdapter.delete).toHaveBeenCalledTimes(1);
    });

    it("proxies batch and CAS operations with retries", async () => {
      let casFailures = 1;
      const customAdapter: StorageAdapter = {
        ...memory,
        name: "cas-store",
        capabilities: { ...memory.capabilities, cas: true, batch: true },
        compareAndSwap: vi.fn().mockImplementation(async (key, expected, update) => {
          if (casFailures > 0) {
            casFailures--;
            throw { code: "ETIMEDOUT" };
          }
          return memory.compareAndSwap ? memory.compareAndSwap(key, expected, update) : true;
        }),
        getMany: vi.fn().mockImplementation(async (keys: string[]) => {
          return memory.getMany ? memory.getMany(keys) : new Map();
        }),
      };

      const wrapped = withRetry(customAdapter, {
        maxRetries: 2,
        initialDelayMs: 5,
        sleepFn: vi.fn().mockResolvedValue(undefined),
      });

      await memory.set("cas-key", "old");
      const casResult = await wrapped.compareAndSwap?.("cas-key", "old", "new");
      expect(casResult).toBe(true);
      expect(customAdapter.compareAndSwap).toHaveBeenCalledTimes(2);

      const mapResult = await wrapped.getMany?.(["cas-key"]);
      expect(mapResult?.get("cas-key")).toBe("new");
    });
  });

  describe("Integration with KVDock Store", () => {
    it("operates seamlessly when wrapping adapter inside KVDock store", async () => {
      const memory = new MemoryAdapter();
      let failures = 1;

      const flakyAdapter: StorageAdapter = {
        ...memory,
        name: "flaky-mem",
        get: vi.fn().mockImplementation(async (k: string) => {
          if (failures > 0) {
            failures--;
            throw { code: "ECONNRESET" };
          }
          return memory.get(k);
        }),
      };

      const resilientAdapter = withRetry(flakyAdapter, {
        maxRetries: 2,
        sleepFn: vi.fn().mockResolvedValue(undefined),
      });

      const dock = new KVDock({
        adapter: resilientAdapter,
        prefix: "app",
      });

      await memory.set("app:counter", 42);

      const value = await dock.get<number>("counter");
      expect(value).toBe(42);
      expect(flakyAdapter.get).toHaveBeenCalledTimes(2);
    });
  });

  describe("RetryMiddleware class", () => {
    it("provides class-based wrap and execute helpers", async () => {
      const middleware = new RetryMiddleware({
        maxRetries: 2,
        sleepFn: vi.fn().mockResolvedValue(undefined),
      });

      let attempts = 0;
      const res = await middleware.execute(async () => {
        attempts++;
        if (attempts === 1) throw { code: "ECONNRESET" };
        return "done";
      });
      expect(res).toBe("done");
      expect(attempts).toBe(2);

      const memory = new MemoryAdapter();
      const wrapped = middleware.wrap(memory);
      expect(wrapped.name).toBe("memory:retry");
    });
  });
});
