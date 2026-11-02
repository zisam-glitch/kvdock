import { beforeEach, describe, expect, it, vi } from "vitest";
import { LibSQLAdapter } from "./index.js";

describe("LibSQLAdapter", () => {
  let adapter: LibSQLAdapter;

  beforeEach(() => {
    adapter = new LibSQLAdapter({ tableName: "turso_kvdock" });
  });

  it("stores and retrieves key-value entries", async () => {
    await adapter.set("org:1", "deepmind");
    expect(await adapter.get("org:1")).toBe("deepmind");
    expect(await adapter.has("org:1")).toBe(true);
  });

  it("returns null for nonexistent keys", async () => {
    expect(await adapter.get("missing")).toBeNull();
  });

  it("handles ttl expiration", async () => {
    vi.useFakeTimers();
    try {
      await adapter.set("timed", "bye", { ttl: 2000 });
      expect(await adapter.get("timed")).toBe("bye");

      vi.advanceTimersByTime(2500);
      expect(await adapter.get("timed")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("deletes entries", async () => {
    await adapter.set("del", "item");
    expect(await adapter.delete("del")).toBe(true);
    expect(await adapter.get("del")).toBeNull();
    expect(await adapter.delete("del")).toBe(false);
  });

  it("performs atomic compareAndSwap", async () => {
    expect(await adapter.compareAndSwap("cas_libsql", null, "v1")).toBe(true);
    expect(await adapter.get("cas_libsql")).toBe("v1");

    expect(await adapter.compareAndSwap("cas_libsql", "wrong", "v2")).toBe(false);
    expect(await adapter.get("cas_libsql")).toBe("v1");

    expect(await adapter.compareAndSwap("cas_libsql", "v1", "v2")).toBe(true);
    expect(await adapter.get("cas_libsql")).toBe("v2");
  });

  it("filters keys by glob", async () => {
    await adapter.set("db:primary", "postgres");
    await adapter.set("db:replica", "aurora");
    await adapter.set("queue:main", "sqs");

    const keys = await adapter.keys("db:*");
    expect(keys.sort()).toEqual(["db:primary", "db:replica"]);
  });

  it("clears table", async () => {
    await adapter.set("k1", "v1");
    await adapter.clear();
    expect(await adapter.get("k1")).toBeNull();
  });
});
