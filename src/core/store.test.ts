import { describe, expect, it } from "vitest";
import { MemoryAdapter } from "../adapters/memory/index.js";
import { TTLValidationError } from "./errors.js";
import { KVDock } from "./store.js";
import type { StorageAdapter, WatchEvent } from "./types.js";

class MockAdapter implements StorageAdapter {
  public readonly name = "mock";
  public readonly capabilities = {
    ttl: true,
    batch: true,
    scan: true,
    cas: false,
    binary: false,
  };

  public data = new Map<string, string>();

  async get<T = unknown>(key: string): Promise<T | null> {
    const val = this.data.get(key);
    return val !== undefined ? (val as unknown as T) : null;
  }

  async set<T = unknown>(key: string, value: T): Promise<void> {
    this.data.set(key, String(value));
  }

  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }

  async has(key: string): Promise<boolean> {
    return this.data.has(key);
  }

  async clear(): Promise<void> {
    this.data.clear();
  }

  async keys(): Promise<string[]> {
    return Array.from(this.data.keys());
  }

  async getMany<T = unknown>(keys: string[]): Promise<Map<string, T | null>> {
    const map = new Map<string, T | null>();
    for (const k of keys) {
      const v = this.data.get(k);
      map.set(k, v !== undefined ? (v as unknown as T) : null);
    }
    return map;
  }

  async setMany<T = unknown>(entries: Array<{ key: string; value: T }>): Promise<void> {
    for (const e of entries) {
      this.data.set(e.key, String(e.value));
    }
  }
}

describe("KVDock core", () => {
  it("prefixes keys transparently", async () => {
    const adapter = new MockAdapter();
    const dock = new KVDock({ adapter, prefix: "app" });

    await dock.set("session", { id: 1 });
    expect(adapter.data.has("app:session")).toBe(true);

    const val = await dock.get<{ id: number }>("session");
    expect(val).toEqual({ id: 1 });

    const keys = await dock.keys();
    expect(keys).toEqual(["session"]);
  });

  it("tracks hit and miss metrics", async () => {
    const adapter = new MockAdapter();
    const dock = new KVDock({ adapter });

    await dock.get("missing");
    expect(dock.stats.misses).toBe(1);

    await dock.set("found", "value");
    await dock.get("found");
    expect(dock.stats.hits).toBe(1);
    expect(dock.stats.sets).toBe(1);
  });

  it("rejects invalid ttl boundary values in set and setMany", async () => {
    const adapter = new MockAdapter();
    const dock = new KVDock({ adapter });
    const invalidTTLs = [0, -1, 0.5, Number.POSITIVE_INFINITY, Number.NaN, "100"];

    for (const ttl of invalidTTLs) {
      await expect(dock.set("k", "v", { ttl: ttl as number })).rejects.toThrow(TTLValidationError);
      await expect(
        dock.setMany([{ key: "k", value: "v", options: { ttl: ttl as number } }]),
      ).rejects.toThrow(TTLValidationError);
    }

    expect(adapter.data.size).toBe(0);
  });

  it("accepts a positive integer ttl", async () => {
    const adapter = new MockAdapter();
    const dock = new KVDock({ adapter });

    await expect(dock.set("k", "v", { ttl: 1 })).resolves.toBeUndefined();
  });

  it("evaluates getOrSet fetcher on miss", async () => {
    const adapter = new MockAdapter();
    const dock = new KVDock({ adapter });

    let calls = 0;
    const fetcher = async () => {
      calls++;
      return { token: "abc" };
    };

    const first = await dock.getOrSet("auth", fetcher);
    expect(first).toEqual({ token: "abc" });
    expect(calls).toBe(1);

    const second = await dock.getOrSet("auth", fetcher);
    expect(second).toEqual({ token: "abc" });
    expect(calls).toBe(1);
  });

  it("handles batch get and set", async () => {
    const adapter = new MockAdapter();
    const dock = new KVDock({ adapter, prefix: "v1" });

    await dock.setMany([
      { key: "a", value: 1 },
      { key: "b", value: 2 },
    ]);

    const res = await dock.getMany<number>(["a", "b", "c"]);
    expect(res.get("a")).toBe(1);
    expect(res.get("b")).toBe(2);
    expect(res.get("c")).toBeNull();
  });

  it("coalesces concurrent requests during cache stampede", async () => {
    const adapter = new MockAdapter();
    const dock = new KVDock({ adapter });

    let fetchCalls = 0;
    const slowFetcher = async () => {
      fetchCalls++;
      await new Promise((r) => setTimeout(r, 20));
      return "expensive_result";
    };

    const results = await Promise.all([
      dock.getOrSet("stampede_key", slowFetcher),
      dock.getOrSet("stampede_key", slowFetcher),
      dock.getOrSet("stampede_key", slowFetcher),
      dock.getOrSet("stampede_key", slowFetcher),
    ]);

    expect(fetchCalls).toBe(1);
    expect(results).toEqual([
      "expensive_result",
      "expensive_result",
      "expensive_result",
      "expensive_result",
    ]);
    expect(dock.stats.stampedeCoalesced).toBe(3);
  });

  it("performs atomic Compare-And-Swap (CAS)", async () => {
    const adapter = new MockAdapter();
    const dock = new KVDock({ adapter });

    // CAS on non-existent key expecting null -> sets initial
    const initOk = await dock.compareAndSwap("cas_item", null, { counter: 1 });
    expect(initOk).toBe(true);
    expect(await dock.get("cas_item")).toEqual({ counter: 1 });

    // CAS with matching expected value -> succeeds
    const updateOk = await dock.compareAndSwap("cas_item", { counter: 1 }, { counter: 2 });
    expect(updateOk).toBe(true);
    expect(await dock.get("cas_item")).toEqual({ counter: 2 });

    // CAS with mismatched expected value -> fails
    const failOk = await dock.compareAndSwap("cas_item", { counter: 999 }, { counter: 3 });
    expect(failOk).toBe(false);
    expect(await dock.get("cas_item")).toEqual({ counter: 2 });
    expect(dock.stats.casSuccess).toBe(2);
    expect(dock.stats.casFailure).toBe(1);
  });

  it("invalidates all keys associated with a tag", async () => {
    const adapter = new MockAdapter();
    const dock = new KVDock({ adapter, prefix: "store" });

    await dock.set("user:1:profile", { name: "Alice" }, { tags: ["user:1"] });
    await dock.set("user:1:settings", { theme: "dark" }, { tags: ["user:1"] });
    await dock.set("user:2:profile", { name: "Bob" }, { tags: ["user:2"] });

    expect(await dock.has("user:1:profile")).toBe(true);
    expect(await dock.has("user:1:settings")).toBe(true);
    expect(await dock.has("user:2:profile")).toBe(true);

    const invalidatedCount = await dock.invalidateTag("user:1");
    expect(invalidatedCount).toBe(2);

    expect(await dock.has("user:1:profile")).toBe(false);
    expect(await dock.has("user:1:settings")).toBe(false);
    expect(await dock.has("user:2:profile")).toBe(true);
  });

  it("invokes logger and lifecycle event listeners", async () => {
    const adapter = new MockAdapter();
    const logs: Array<{ level: string; msg: string }> = [];
    const events: string[] = [];

    const dock = new KVDock({
      adapter,
      logger: (level, msg) => logs.push({ level, msg }),
      onEvent: (evt) => events.push(evt.type),
    });

    await dock.set("log_test", "123");
    await dock.get("log_test");
    await dock.get("missing_log");
    await dock.delete("log_test");

    expect(events).toContain("set");
    expect(events).toContain("hit");
    expect(events).toContain("miss");
    expect(events).toContain("delete");
    expect(logs.length).toBeGreaterThan(0);
  });

  it("verifies prefix resolution invariance across 1000 randomized property checks", async () => {
    const adapter = new MockAdapter();
    const dock = new KVDock({ adapter, prefix: "namespace_test" });

    const characters = "abcdefghijklmnopqrstuvwxyz0123456789-_/.:🚀✨";
    for (let i = 0; i < 1000; i++) {
      const len = 1 + Math.floor(Math.random() * 20);
      let randKey = "";
      for (let j = 0; j < len; j++) {
        randKey += characters[Math.floor(Math.random() * characters.length)];
      }

      await dock.set(randKey, i);
      const retrieved = await dock.get<number>(randKey);
      expect(retrieved).toBe(i);
      expect(await dock.has(randKey)).toBe(true);
    }
  });

  it("supports custom ValueCodec interfaces", async () => {
    const adapter = new MockAdapter();

    interface UserPayload {
      id: number;
      username: string;
    }

    // Custom binary/hex string codec
    const hexCodec = {
      encode(user: UserPayload): string {
        return Buffer.from(JSON.stringify(user)).toString("hex");
      },
      decode(raw: string): UserPayload {
        return JSON.parse(Buffer.from(raw, "hex").toString("utf-8"));
      },
    };

    const dock = new KVDock({
      adapter,
      codec: hexCodec,
    });

    await dock.set("user:42", { id: 42, username: "dev" });

    // Raw stored value should be hex encoded
    const rawVal = adapter.data.get("user:42");
    expect(rawVal).not.toContain("username");

    // Retrieved should be typed decoded object
    const decoded = await dock.get<UserPayload>("user:42");
    expect(decoded).toEqual({ id: 42, username: "dev" });
  });

  it("enforces operation timeout and aborts lagging adapters", async () => {
    class LaggyAdapter extends MockAdapter {
      override async get<T = unknown>(_key: string): Promise<T | null> {
        await new Promise((r) => setTimeout(r, 80));
        return "slow" as unknown as T;
      }
    }

    const dock = new KVDock({
      adapter: new LaggyAdapter(),
      timeoutMs: 25,
    });

    await expect(dock.get("slow_key")).rejects.toThrow(/timed out after 25ms/);
  });

  it("handles partial failure during batch iteration without crashing", async () => {
    class FlakyBatchAdapter extends MockAdapter {
      override capabilities = {
        ...super.capabilities,
        batch: false,
      };

      override async set<T = unknown>(key: string, value: T): Promise<void> {
        if (key === "fail_me") {
          throw new Error("simulated driver write failure");
        }
        await super.set(key, value);
      }
    }

    const dock = new KVDock({ adapter: new FlakyBatchAdapter() });

    await expect(
      dock.setMany([
        { key: "ok1", value: "1" },
        { key: "fail_me", value: "2" },
        { key: "ok2", value: "3" },
      ]),
    ).rejects.toThrow("simulated driver write failure");
  });

  describe("Stale-While-Revalidate (SWR) and XFetch Stampede Prevention", () => {
    it("serves stale value immediately and updates cache in background", async () => {
      const adapter = new MockAdapter();
      const events: string[] = [];
      const dock = new KVDock({
        adapter,
        onEvent: (e) => events.push(e.type),
      });

      let fetchCount = 0;
      const fetcher = async () => {
        fetchCount++;
        return { count: fetchCount };
      };

      // Initial populate with ttl: 50ms, swr: 200ms
      const initial = await dock.getOrSet("swr_key", fetcher, {
        ttl: 50,
        staleWhileRevalidate: 300,
      });
      expect(initial).toEqual({ count: 1 });
      expect(fetchCount).toBe(1);

      // Sleep 70ms: key is now expired (past 50ms) but within SWR window (50ms + 300ms = 350ms)
      await new Promise((r) => setTimeout(r, 70));

      // Immediate call returns stale data with 0ms wait!
      const staleResult = await dock.getOrSet("swr_key", fetcher, {
        ttl: 50,
        staleWhileRevalidate: 300,
      });
      expect(staleResult).toEqual({ count: 1 });
      expect(events).toContain("stale_hit");
      expect(events).toContain("background_refresh");
      expect(dock.stats.staleHits).toBe(1);
      expect(dock.stats.backgroundRefreshes).toBe(1);

      // Wait 30ms for background promise to finish updating the cache
      await new Promise((r) => setTimeout(r, 40));
      expect(fetchCount).toBe(2);

      // Next call retrieves fresh value from background update
      const freshResult = await dock.get("swr_key");
      expect(freshResult).toEqual({ count: 2 });
    });

    it("coalesces concurrent requests during background refresh so fetcher runs only once", async () => {
      const adapter = new MockAdapter();
      const dock = new KVDock({ adapter });

      let fetchCount = 0;
      const fetcher = async () => {
        fetchCount++;
        await new Promise((r) => setTimeout(r, 20));
        return { val: fetchCount };
      };

      await dock.getOrSet("coalesce_key", fetcher, {
        ttl: 40,
        staleWhileRevalidate: 400,
      });
      expect(fetchCount).toBe(1);

      await new Promise((r) => setTimeout(r, 60));

      // 20 concurrent requests hitting the stale key simultaneously
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          dock.getOrSet("coalesce_key", fetcher, {
            ttl: 40,
            staleWhileRevalidate: 400,
          }),
        ),
      );

      // All 20 immediately got the stale value without waiting
      for (const res of results) {
        expect(res).toEqual({ val: 1 });
      }

      // Wait for background refresh to finish
      await new Promise((r) => setTimeout(r, 40));

      // fetchCount only incremented ONCE (single-flight background refresh!)
      expect(fetchCount).toBe(2);
      expect(dock.stats.backgroundRefreshes).toBe(1);
    });

    it("supports XFetch probabilistic early recomputation", async () => {
      const adapter = new MockAdapter();
      const events: string[] = [];
      const dock = new KVDock({
        adapter,
        onEvent: (e) => events.push(e.type),
      });

      let fetchCount = 0;
      const fetcher = async () => {
        fetchCount++;
        await new Promise((r) => setTimeout(r, 15));
        return `val_${fetchCount}`;
      };

      // Populate with xfetch enabled and large beta to ensure deterministic recomputation trigger
      const first = await dock.getOrSet("xfetch_key", fetcher, {
        ttl: 40,
        xfetch: true,
        beta: 10.0,
      });
      expect(first).toBe("val_1");
      expect(fetchCount).toBe(1);

      // Call while still fresh (within 40ms): XFetch triggers background refresh
      const second = await dock.getOrSet("xfetch_key", fetcher, {
        ttl: 40,
        xfetch: true,
        beta: 10.0,
        randomFn: () => 0.01,
      });
      expect(second).toBe("val_1");
      expect(events).toContain("background_refresh");

      await new Promise((r) => setTimeout(r, 30));
      expect(fetchCount).toBe(2);
    });

    it("serves cached stale value in Grace Mode when upstream fetcher fails", async () => {
      const adapter = new MockAdapter();
      const events: string[] = [];
      const dock = new KVDock({
        adapter,
        onEvent: (e) => events.push(e.type),
      });

      // 1. Initial successful population
      const first = await dock.getOrSet("user_profile", () => ({ id: 42, role: "admin" }), {
        ttl: 20,
        gracePeriodMs: 500,
      });
      expect(first).toEqual({ id: 42, role: "admin" });

      // 2. Wait for initial TTL to expire (20ms), entering grace window
      await new Promise((r) => setTimeout(r, 30));

      // 3. Upstream DB is down / fetcher throws
      const failingFetcher = async () => {
        throw new Error("Database connection timeout");
      };

      const fallback = await dock.getOrSet("user_profile", failingFetcher, {
        ttl: 20,
        gracePeriodMs: 500,
      });

      expect(fallback).toEqual({ id: 42, role: "admin" });
      expect(dock.stats.graceHits).toBe(1);
      expect(events).toContain("grace_hit");
    });
  });

  describe("Middleware Interceptors and Reactive Watchers", () => {
    it("transforms keys and values through interceptor pipeline", async () => {
      const adapter = new MockAdapter();
      const dock = new KVDock({ adapter });

      dock.use({
        beforeSet: (key, val, opts) => ({
          key: `tenantA:${key}`,
          value: typeof val === "string" ? val.toUpperCase() : val,
          options: opts,
        }),
        beforeGet: (key) => `tenantA:${key}`,
        afterGet: (_key, val) => (typeof val === "string" ? `[processed] ${val}` : val),
      });

      await dock.set("message", "hello world");
      const result = await dock.get("message");

      expect(result).toBe("[processed] HELLO WORLD");
    });

    it("notifies reactive storage watchers on set, delete, and clear", async () => {
      const adapter = new MockAdapter();
      const dock = new KVDock({ adapter });

      const events: WatchEvent[] = [];
      const unsubscribe = dock.watch((e) => {
        events.push(e);
      });

      await dock.set("session:abc", { loggedIn: true });
      await dock.delete("session:abc");
      await dock.clear();

      expect(events).toEqual([
        { type: "set", key: "session:abc", value: { loggedIn: true } },
        { type: "delete", key: "session:abc" },
        { type: "clear" },
      ]);

      unsubscribe();
      await dock.set("ignored", 123);
      expect(events).toHaveLength(3);
    });
  });

  describe("Atomic Counters (increment / decrement)", () => {
    it("increments a non-existent key initializing it to delta", async () => {
      const adapter = new MockAdapter();
      const dock = new KVDock({ adapter });

      const res1 = await dock.increment("counter");
      expect(res1).toBe(1);
      expect(await dock.get<number>("counter")).toBe(1);

      const res2 = await dock.increment("custom_init", 42);
      expect(res2).toBe(42);
      expect(await dock.get<number>("custom_init")).toBe(42);
    });

    it("increments an existing numeric key by positive and negative deltas", async () => {
      const adapter = new MockAdapter();
      const dock = new KVDock({ adapter });

      await dock.set("views", 100);
      const val1 = await dock.increment("views", 5);
      expect(val1).toBe(105);
      expect(await dock.get<number>("views")).toBe(105);

      const val2 = await dock.increment("views", -15);
      expect(val2).toBe(90);
      expect(await dock.get<number>("views")).toBe(90);
    });

    it("supports decrement wrapper", async () => {
      const adapter = new MockAdapter();
      const dock = new KVDock({ adapter });

      await dock.set("stock", 50);
      const val1 = await dock.decrement("stock");
      expect(val1).toBe(49);

      const val2 = await dock.decrement("stock", 9);
      expect(val2).toBe(40);
      expect(await dock.get<number>("stock")).toBe(40);

      const val3 = await dock.decrement("new_stock", 5);
      expect(val3).toBe(-5);
      expect(await dock.get<number>("new_stock")).toBe(-5);
    });

    it("handles floating point decimal increments", async () => {
      const adapter = new MockAdapter();
      const dock = new KVDock({ adapter });

      await dock.set("balance", 10.5);
      const val = await dock.increment("balance", 2.25);
      expect(val).toBeCloseTo(12.75);
    });

    it("handles numeric strings stored in adapter", async () => {
      const adapter = new MockAdapter();
      const dock = new KVDock({ adapter });

      await dock.set("str_num", "99");
      const val = await dock.increment("str_num", 1);
      expect(val).toBe(100);
    });

    it("throws TypeError on non-finite delta", async () => {
      const adapter = new MockAdapter();
      const dock = new KVDock({ adapter });

      // @ts-expect-error invalid delta type testing
      await expect(dock.increment("k", "invalid")).rejects.toThrow(TypeError);
      await expect(dock.increment("k", Number.NaN)).rejects.toThrow(TypeError);
      await expect(dock.increment("k", Number.POSITIVE_INFINITY)).rejects.toThrow(TypeError);
      // @ts-expect-error invalid delta type testing
      await expect(dock.decrement("k", "invalid")).rejects.toThrow(TypeError);
    });

    it("throws TypeError when incrementing non-numeric existing value", async () => {
      const adapter = new MockAdapter();
      const dock = new KVDock({ adapter });

      await dock.set("obj_key", { count: 1 });
      await expect(dock.increment("obj_key", 1)).rejects.toThrow(TypeError);

      await dock.set("bool_key", true);
      await expect(dock.increment("bool_key", 1)).rejects.toThrow(TypeError);

      await dock.set("str_key", "hello");
      await expect(dock.increment("str_key", 1)).rejects.toThrow(TypeError);
    });

    it("delegates to adapter.increment if natively provided", async () => {
      let adapterCalled = false;
      const nativeAdapter: StorageAdapter = {
        name: "native-inc",
        capabilities: { ttl: true, batch: false, scan: false, cas: false, binary: false },
        get: async () => null,
        set: async () => {},
        delete: async () => true,
        has: async () => false,
        clear: async () => {},
        keys: async () => [],
        increment: async (_key, delta) => {
          adapterCalled = true;
          return 100 + (delta ?? 1);
        },
      };

      const dock = new KVDock({ adapter: nativeAdapter });
      const result = await dock.increment("page:hits", 5);
      expect(adapterCalled).toBe(true);
      expect(result).toBe(105);
    });

    it("handles concurrent increments without race conditions (CAS retry loop)", async () => {
      const adapter = new MemoryAdapter();
      const dock = new KVDock({ adapter });

      const concurrency = 25;
      const promises = Array.from({ length: concurrency }, () => dock.increment("shared_counter"));
      const results = await Promise.all(promises);

      expect(results).toHaveLength(concurrency);
      const finalVal = await dock.get<number>("shared_counter");
      expect(finalVal).toBe(concurrency);
    });

    it("emits increment and decrement events and notifies watchers", async () => {
      const adapter = new MockAdapter();
      const emittedEvents: Array<{ type: string; key?: string }> = [];
      const watchEvents: WatchEvent[] = [];

      const dock = new KVDock({
        adapter,
        onEvent: (e) => {
          emittedEvents.push({ type: e.type, key: e.key });
        },
      });

      dock.watch((e) => {
        watchEvents.push(e);
      });

      await dock.increment("counter", 10);
      await dock.decrement("counter", 3);

      expect(emittedEvents.some((e) => e.type === "increment" && e.key === "counter")).toBe(true);
      expect(emittedEvents.some((e) => e.type === "decrement" && e.key === "counter")).toBe(true);
      expect(watchEvents.some((e) => e.type === "set" && e.key === "counter")).toBe(true);
    });
  });

  describe("dock.touch and dock.ttl", () => {
    it("refreshes TTL non-destructively on existing keys", async () => {
      const adapter = new MemoryAdapter();
      const dock = new KVDock({ adapter });

      await dock.set("session", { user: "alice" }, { ttl: 50 });
      const initialTtl = await dock.ttl("session");
      expect(initialTtl).toBeGreaterThan(0);
      expect(initialTtl).toBeLessThanOrEqual(50);

      // Refresh TTL non-destructively to 5000ms
      const touched = await dock.touch("session", 5000);
      expect(touched).toBe(true);

      const refreshedTtl = await dock.ttl("session");
      expect(refreshedTtl).toBeGreaterThan(4000);
      expect(refreshedTtl).toBeLessThanOrEqual(5000);

      // Stored value remains identical
      const value = await dock.get<{ user: string }>("session");
      expect(value).toEqual({ user: "alice" });
    });

    it("returns false from touch for missing or expired keys", async () => {
      const adapter = new MemoryAdapter();
      const dock = new KVDock({ adapter });

      expect(await dock.touch("nonexistent", 1000)).toBe(false);
      expect(await dock.ttl("nonexistent")).toBeNull();

      await dock.set("expired", "bye", { ttl: 10 });
      await new Promise((r) => setTimeout(r, 25));
      expect(await dock.touch("expired", 1000)).toBe(false);
      expect(await dock.ttl("expired")).toBeNull();
    });

    it("uses defaultTTL when ttl argument is omitted in touch", async () => {
      const adapter = new MemoryAdapter();
      const dock = new KVDock({ adapter, defaultTTL: 3000 });

      await dock.set("pref", "dark");
      expect(await dock.ttl("pref")).toBeGreaterThan(0);

      const touched = await dock.touch("pref");
      expect(touched).toBe(true);

      const remaining = await dock.ttl("pref");
      expect(remaining).toBeGreaterThan(2000);
      expect(remaining).toBeLessThanOrEqual(3000);
    });

    it("throws TTLValidationError on invalid ttl for touch", async () => {
      const adapter = new MemoryAdapter();
      const dock = new KVDock({ adapter });

      await dock.set("item", "test");
      await expect(dock.touch("item")).rejects.toThrow(TTLValidationError);
      await expect(dock.touch("item", 0)).rejects.toThrow(TTLValidationError);
      await expect(dock.touch("item", -50)).rejects.toThrow(TTLValidationError);
      await expect(dock.touch("item", 1.5)).rejects.toThrow(TTLValidationError);
    });

    it("returns null for ttl on persistent keys with no expiration", async () => {
      const adapter = new MemoryAdapter();
      const dock = new KVDock({ adapter });

      await dock.set("forever", "immortal");
      expect(await dock.ttl("forever")).toBeNull();
    });

    it("works with adapters lacking native touch/ttl via fallback", async () => {
      const fallbackAdapter = new MockAdapter();
      const dock = new KVDock({ adapter: fallbackAdapter });

      await dock.set("cached", { foo: "bar" });
      const touched = await dock.touch("cached", 2000);
      expect(touched).toBe(true);

      const value = await dock.get<{ foo: string }>("cached");
      expect(value).toEqual({ foo: "bar" });

      // Touching nonexistent key returns false
      expect(await dock.touch("missing", 2000)).toBe(false);
    });

    it("refreshes TTL for SWR cached entries in getOrSet", async () => {
      const adapter = new MemoryAdapter();
      const dock = new KVDock({ adapter });

      let fetches = 0;
      await dock.getOrSet(
        "swr_key",
        async () => {
          fetches++;
          return { data: "fresh" };
        },
        { ttl: 100, staleWhileRevalidate: 200 },
      );

      expect(fetches).toBe(1);
      const initialTtl = await dock.ttl("swr_key");
      expect(initialTtl).toBeGreaterThan(0);
      expect(initialTtl).toBeLessThanOrEqual(100);

      // Touch with 5000ms TTL
      const touched = await dock.touch("swr_key", 5000);
      expect(touched).toBe(true);

      const refreshedTtl = await dock.ttl("swr_key");
      expect(refreshedTtl).toBeGreaterThan(4500);

      const cached = await dock.get<{ data: string }>("swr_key");
      expect(cached).toEqual({ data: "fresh" });
      expect(fetches).toBe(1);
    });

    it("emits touch event and notifies watchers", async () => {
      const adapter = new MemoryAdapter();
      const emitted: Array<{ type: string; key?: string; meta?: Record<string, unknown> }> = [];
      const watched: WatchEvent[] = [];

      const dock = new KVDock({
        adapter,
        onEvent: (e) => emitted.push({ type: e.type, key: e.key, meta: e.meta }),
      });

      dock.watch((e) => watched.push(e));

      await dock.set("watched_key", "val", { ttl: 1000 });
      await dock.touch("watched_key", 6000);

      expect(emitted.some((e) => e.type === "touch" && e.key === "watched_key")).toBe(true);
      expect(
        watched.some((e) => e.type === "touch" && e.key === "watched_key" && e.ttl === 6000),
      ).toBe(true);
    });
  });
});
