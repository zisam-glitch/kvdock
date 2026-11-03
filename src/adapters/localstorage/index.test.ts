import { beforeEach, describe, expect, it, vi } from "vitest";
import { KVDockError } from "../../core/errors.js";
import { LocalStorageAdapter } from "./index.js";

function createMockStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  } as Storage;
}

describe("LocalStorageAdapter", () => {
  let mockStorage: Storage;
  let adapter: LocalStorageAdapter;

  beforeEach(() => {
    mockStorage = createMockStorage();
    adapter = new LocalStorageAdapter({ storage: mockStorage, prefix: "test:" });
  });

  it("sets and gets simple string values", async () => {
    await adapter.set("greeting", "hello world");
    const val = await adapter.get("greeting");
    expect(val).toBe("hello world");
    expect(await adapter.has("greeting")).toBe(true);
  });

  it("returns null for nonexistent keys", async () => {
    expect(await adapter.get("missing")).toBeNull();
    expect(await adapter.has("missing")).toBe(false);
  });

  it("handles ttl expiration", async () => {
    vi.useFakeTimers();
    try {
      await adapter.set("temporary", "bye", { ttl: 2000 });
      expect(await adapter.get("temporary")).toBe("bye");

      vi.advanceTimersByTime(2500);
      expect(await adapter.get("temporary")).toBeNull();
      expect(await adapter.has("temporary")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("deletes keys", async () => {
    await adapter.set("target", "delete-me");
    expect(await adapter.delete("target")).toBe(true);
    expect(await adapter.get("target")).toBeNull();
    expect(await adapter.delete("target")).toBe(false);
  });

  it("performs batch operations", async () => {
    await adapter.setMany([
      { key: "k1", value: "v1" },
      { key: "k2", value: "v2" },
      { key: "k3", value: "v3" },
    ]);

    const values = await adapter.getMany(["k1", "k2", "nonexistent"]);
    expect(values.get("k1")).toBe("v1");
    expect(values.get("k2")).toBe("v2");
    expect(values.get("nonexistent")).toBeNull();

    const deletedCount = await adapter.deleteMany(["k1", "k3", "k4"]);
    expect(deletedCount).toBe(2);
    expect(await adapter.get("k1")).toBeNull();
    expect(await adapter.get("k2")).toBe("v2");
  });

  it("supports atomic compareAndSwap", async () => {
    expect(await adapter.compareAndSwap("cas-key", null, "initial")).toBe(true);
    expect(await adapter.get("cas-key")).toBe("initial");

    expect(await adapter.compareAndSwap("cas-key", "wrong", "next")).toBe(false);
    expect(await adapter.get("cas-key")).toBe("initial");

    expect(await adapter.compareAndSwap("cas-key", "initial", "updated")).toBe(true);
    expect(await adapter.get("cas-key")).toBe("updated");
  });

  it("scans keys matching glob pattern", async () => {
    await adapter.set("user:1", "alice");
    await adapter.set("user:2", "bob");
    await adapter.set("session:abc", "data");

    const matched: string[] = [];
    for await (const k of adapter.scan("user:*")) {
      matched.push(k);
    }
    expect(matched.sort()).toEqual(["user:1", "user:2"]);
  });

  it("clears only prefixed keys", async () => {
    mockStorage.setItem("other:key", "keep");
    await adapter.set("k1", "v1");
    await adapter.clear();

    expect(await adapter.get("k1")).toBeNull();
    expect(mockStorage.getItem("other:key")).toBe("keep");
  });

  it("handles storage write errors with KVDockError", async () => {
    const errorStorage = createMockStorage();
    errorStorage.setItem = () => {
      throw new Error("QuotaExceededError: Quota exceeded");
    };
    const failAdapter = new LocalStorageAdapter({ storage: errorStorage });
    await expect(failAdapter.set("k", "v")).rejects.toThrow(KVDockError);
  });

  it("safely handles malformed and non-envelope JSON without throwing", async () => {
    // 1. Broken syntax
    mockStorage.setItem("test:corrupted", "{ this is not valid json");
    expect(await adapter.get("corrupted")).toBeNull();
    expect(await adapter.has("corrupted")).toBe(false);

    // 2. Primitive JSON values (number, boolean, string, null)
    mockStorage.setItem("test:num", "12345");
    expect(await adapter.get("num")).toBeNull();
    expect(await adapter.has("num")).toBe(false);

    mockStorage.setItem("test:bool", "true");
    expect(await adapter.get("bool")).toBeNull();

    mockStorage.setItem("test:str", '"raw string without envelope"');
    expect(await adapter.get("str")).toBeNull();

    mockStorage.setItem("test:null_literal", "null");
    expect(await adapter.get("null_literal")).toBeNull();

    // 3. Object missing envelope field 'v'
    mockStorage.setItem("test:foreign_obj", JSON.stringify({ custom: "data", count: 1 }));
    expect(await adapter.get("foreign_obj")).toBeNull();

    // 4. Listing keys skips malformed entries
    await adapter.set("valid", "good value");
    const keys = await adapter.keys();
    expect(keys).toEqual(["valid"]);
  });
});
