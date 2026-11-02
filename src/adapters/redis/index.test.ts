import { describe, expect, it } from "vitest";
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
}

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
});
