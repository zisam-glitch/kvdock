import { describe, expect, it } from "vitest";
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
});
