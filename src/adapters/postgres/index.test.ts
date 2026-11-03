import { beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresAdapter } from "./index.js";

describe("PostgresAdapter", () => {
  let adapter: PostgresAdapter;

  beforeEach(() => {
    adapter = new PostgresAdapter({ tableName: "pg_kvdock" });
  });

  it("stores and retrieves key-value entries", async () => {
    await adapter.set("cluster_leader", "node_us_east_1");
    expect(await adapter.get("cluster_leader")).toBe("node_us_east_1");
    expect(await adapter.has("cluster_leader")).toBe(true);
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
    expect(await adapter.compareAndSwap("cas_pg", null, "v1")).toBe(true);
    expect(await adapter.get("cas_pg")).toBe("v1");

    expect(await adapter.compareAndSwap("cas_pg", "wrong", "v2")).toBe(false);
    expect(await adapter.get("cas_pg")).toBe("v1");

    expect(await adapter.compareAndSwap("cas_pg", "v1", "v2")).toBe(true);
    expect(await adapter.get("cas_pg")).toBe("v2");
  });

  it("filters keys by glob", async () => {
    await adapter.set("srv:web1", "1");
    await adapter.set("srv:web2", "2");
    await adapter.set("db:aurora", "3");

    const keys = await adapter.keys("srv:*");
    expect(keys.sort()).toEqual(["srv:web1", "srv:web2"]);
  });

  it("clears table", async () => {
    await adapter.set("k1", "v1");
    await adapter.clear();
    expect(await adapter.get("k1")).toBeNull();
  });
});
