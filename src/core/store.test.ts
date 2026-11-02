import { describe, expect, it } from "vitest";
import { TTLValidationError } from "./errors.js";
import { KVDock } from "./store.js";
import type { StorageAdapter } from "./types.js";

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
});
