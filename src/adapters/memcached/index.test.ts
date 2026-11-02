import { describe, expect, it, vi } from "vitest";
import { MemcachedAdapter, type MemcachedClientInterface } from "./index.js";

describe("MemcachedAdapter", () => {
  it("validates key length and invalid spaces", async () => {
    const mockClient: MemcachedClientInterface = {
      get: vi.fn(),
      set: vi.fn(),
      del: vi.fn(),
    };
    const adapter = new MemcachedAdapter({ client: mockClient });
    await expect(adapter.set("invalid key with space", "value")).rejects.toThrow();
  });

  it("performs get, set, delete, and has with mocked client", async () => {
    const memory = new Map<string, { value: string; lifetime: number }>();

    const mockClient: MemcachedClientInterface = {
      get: vi.fn(async (key: string) => {
        const item = memory.get(key);
        return item ? item.value : null;
      }),
      set: vi.fn(async (key: string, val: string, lifetime: number) => {
        memory.set(key, { value: val, lifetime });
        return true;
      }),
      del: vi.fn(async (key: string) => {
        return memory.delete(key);
      }),
      flush: vi.fn(async () => {
        memory.clear();
        return true;
      }),
    };

    const adapter = new MemcachedAdapter({
      client: mockClient,
      prefix: "cache:",
    });

    await adapter.set("session_123", { userId: 42, active: true }, { ttl: 60_000 });
    expect(await adapter.has("session_123")).toBe(true);

    const session = await adapter.get<{ userId: number; active: boolean }>("session_123");
    expect(session).toEqual({ userId: 42, active: true });

    const keys = await adapter.keys();
    expect(keys).toContain("session_123");

    expect(await adapter.delete("session_123")).toBe(true);
    expect(await adapter.has("session_123")).toBe(false);
  });

  it("handles multi-get batch operations", async () => {
    const memory = new Map<string, string>([
      ["p:a", JSON.stringify("alpha")],
      ["p:b", JSON.stringify("beta")],
    ]);

    const mockClient: MemcachedClientInterface = {
      get: vi.fn(async (key) => memory.get(key) ?? null),
      set: vi.fn(async (key, val) => {
        memory.set(key, val);
        return true;
      }),
      del: vi.fn(async (key) => memory.delete(key)),
      getMulti: vi.fn(async (keys: string[]) => {
        const res: Record<string, string> = {};
        for (const k of keys) {
          const val = memory.get(k);
          if (val !== undefined) res[k] = val;
        }
        return res;
      }),
    };

    const adapter = new MemcachedAdapter({
      client: mockClient,
      prefix: "p:",
    });

    await adapter.setMany([
      { key: "a", value: "alpha" },
      { key: "b", value: "beta" },
    ]);

    const batch = await adapter.getMany(["a", "b", "c"]);
    expect(batch.get("a")).toBe("alpha");
    expect(batch.get("b")).toBe("beta");
    expect(batch.get("c")).toBeNull();

    const deletedCount = await adapter.deleteMany(["a", "b"]);
    expect(deletedCount).toBe(2);
  });
});
