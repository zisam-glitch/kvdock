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
});
