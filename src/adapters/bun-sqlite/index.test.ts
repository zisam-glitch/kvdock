import { beforeEach, describe, expect, it, vi } from "vitest";
import { BunSQLiteAdapter } from "./index.js";

describe("BunSQLiteAdapter", () => {
  let adapter: BunSQLiteAdapter;

  beforeEach(() => {
    adapter = new BunSQLiteAdapter({ tableName: "test_kvdock" });
  });

  it("sets and gets string values", async () => {
    await adapter.set("greeting", "hello bun");
    expect(await adapter.get("greeting")).toBe("hello bun");
    expect(await adapter.has("greeting")).toBe(true);
  });

  it("returns null for nonexistent keys", async () => {
    expect(await adapter.get("missing")).toBeNull();
    expect(await adapter.has("missing")).toBe(false);
  });

  it("honors ttl expiration", async () => {
    vi.useFakeTimers();
    try {
      await adapter.set("timed", "expiring", { ttl: 2000 });
      expect(await adapter.get("timed")).toBe("expiring");

      vi.advanceTimersByTime(2500);
      expect(await adapter.get("timed")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("deletes existing keys", async () => {
    await adapter.set("to_delete", "val");
    expect(await adapter.delete("to_delete")).toBe(true);
    expect(await adapter.get("to_delete")).toBeNull();
    expect(await adapter.delete("to_delete")).toBe(false);
  });

  it("performs atomic compareAndSwap", async () => {
    expect(await adapter.compareAndSwap("cas_key", null, "v1")).toBe(true);
    expect(await adapter.get("cas_key")).toBe("v1");

    expect(await adapter.compareAndSwap("cas_key", "wrong", "v2")).toBe(false);
    expect(await adapter.get("cas_key")).toBe("v1");

    expect(await adapter.compareAndSwap("cas_key", "v1", "v2")).toBe(true);
    expect(await adapter.get("cas_key")).toBe("v2");
  });

  it("filters keys by glob pattern", async () => {
    await adapter.set("user:10", "alice");
    await adapter.set("user:20", "bob");
    await adapter.set("session:abc", "data");

    const users = await adapter.keys("user:*");
    expect(users.sort()).toEqual(["user:10", "user:20"]);
  });

  it("clears all keys in the table", async () => {
    await adapter.set("k1", "v1");
    await adapter.clear();
    expect(await adapter.get("k1")).toBeNull();
  });
});
