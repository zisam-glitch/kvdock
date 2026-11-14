import { describe, expect, it } from "vitest";
import { defineAdapterTestSuite } from "../../testing/index.js";
import { RedisAdapter, type RedisClientInterface } from "./index.js";

class MockRedisClient implements RedisClientInterface {
  private readonly data = new Map<string, { value: string; expiresAt?: number }>();

  public async get(key: string): Promise<string | null> {
    const entry = this.data.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      this.data.delete(key);
      return null;
    }
    return entry.value;
  }

  public async set(key: string, value: string, ...args: Array<string | number>): Promise<unknown> {
    const exists = this.data.has(key);
    let ttlMs: number | undefined;

    for (let i = 0; i < args.length; i++) {
      if (args[i] === "NX" && exists) return null;
      if (args[i] === "XX" && !exists) return null;
      if (args[i] === "PX" && typeof args[i + 1] === "number") {
        ttlMs = args[i + 1] as number;
      }
    }

    const expiresAt = ttlMs ? Date.now() + ttlMs : undefined;
    this.data.set(key, { value, expiresAt });
    return "OK";
  }

  public async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      if (this.data.delete(key)) count++;
    }
    return count;
  }

  public async exists(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      if (this.data.has(key)) count++;
    }
    return count;
  }

  public async keys(pattern: string): Promise<string[]> {
    const regex = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`);
    return Array.from(this.data.keys()).filter((k) => regex.test(k));
  }

  public async mget(...keys: string[]): Promise<Array<string | null>> {
    const results: Array<string | null> = [];
    for (const k of keys) {
      results.push(await this.get(k));
    }
    return results;
  }

  public async flushdb(): Promise<unknown> {
    this.data.clear();
    return "OK";
  }

  public async pexpire(key: string, ms: number): Promise<number> {
    const entry = this.data.get(key);
    if (!entry) return 0;
    entry.expiresAt = Date.now() + ms;
    return 1;
  }

  public async pttl(key: string): Promise<number> {
    const entry = this.data.get(key);
    if (!entry) return -2;
    if (!entry.expiresAt) return -1;
    const diff = entry.expiresAt - Date.now();
    return diff > 0 ? diff : 0;
  }
}

defineAdapterTestSuite({
  name: "RedisAdapter",
  createAdapter: () => new RedisAdapter({ client: new MockRedisClient() }),
});

describe("RedisAdapter", () => {
  it("stores and retrieves basic values with prefix", async () => {
    const mock = new MockRedisClient();
    const adapter = new RedisAdapter({ client: mock, prefix: "test:" });

    await adapter.set("greeting", "hello");
    expect(await adapter.get("greeting")).toBe("hello");
    expect(await adapter.has("greeting")).toBe(true);

    const keys = await adapter.keys();
    expect(keys).toContain("greeting");

    const deleted = await adapter.delete("greeting");
    expect(deleted).toBe(true);
    expect(await adapter.get("greeting")).toBeNull();
  });

  it("handles conditional writes (nx/xx)", async () => {
    const mock = new MockRedisClient();
    const adapter = new RedisAdapter({ client: mock });

    await adapter.set("key", "first", { xx: true });
    expect(await adapter.get("key")).toBeNull();

    await adapter.set("key", "first", { nx: true });
    expect(await adapter.get("key")).toBe("first");

    await adapter.set("key", "second", { nx: true });
    expect(await adapter.get("key")).toBe("first");

    await adapter.set("key", "second", { xx: true });
    expect(await adapter.get("key")).toBe("second");
  });

  it("handles batch operations", async () => {
    const mock = new MockRedisClient();
    const adapter = new RedisAdapter({ client: mock });

    await adapter.setMany([
      { key: "a", value: "1" },
      { key: "b", value: "2" },
      { key: "c", value: "3" },
    ]);

    const res = await adapter.getMany(["a", "b", "c", "missing"]);
    expect(res.get("a")).toBe("1");
    expect(res.get("b")).toBe("2");
    expect(res.get("c")).toBe("3");
    expect(res.get("missing")).toBeNull();

    const deletedCount = await adapter.deleteMany(["a", "b"]);
    expect(deletedCount).toBe(2);
    expect(await adapter.get("a")).toBeNull();
  });

  it("supports ttl expiration", async () => {
    const mock = new MockRedisClient();
    const adapter = new RedisAdapter({ client: mock });

    await adapter.set("temp", "val", { ttl: 20 });
    expect(await adapter.get("temp")).toBe("val");

    await new Promise((r) => setTimeout(r, 30));
    expect(await adapter.get("temp")).toBeNull();
  });

  it("supports touch and ttl inspection", async () => {
    const mock = new MockRedisClient();
    const adapter = new RedisAdapter({ client: mock });

    await adapter.set("timed", "val", { ttl: 50 });
    const remaining = await adapter.ttl("timed");
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(50);

    const touched = await adapter.touch("timed", 5000);
    expect(touched).toBe(true);

    const newTtl = await adapter.ttl("timed");
    expect(newTtl).toBeGreaterThan(4000);
    expect(newTtl).toBeLessThanOrEqual(5000);

    expect(await adapter.touch("missing", 1000)).toBe(false);
    expect(await adapter.ttl("missing")).toBeNull();
  });
});
