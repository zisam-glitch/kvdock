import { beforeEach, describe, expect, it, vi } from "vitest";
import { D1Adapter } from "./index.js";

describe("Cloudflare D1Adapter", () => {
  let adapter: D1Adapter;

  beforeEach(() => {
    adapter = new D1Adapter({ tableName: "cf_kvdock" });
  });

  it("stores and retrieves key-value entries", async () => {
    await adapter.set("worker_flag", "enabled");
    expect(await adapter.get("worker_flag")).toBe("enabled");
    expect(await adapter.has("worker_flag")).toBe(true);
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
    expect(await adapter.compareAndSwap("cas_d1", null, "v1")).toBe(true);
    expect(await adapter.get("cas_d1")).toBe("v1");

    expect(await adapter.compareAndSwap("cas_d1", "wrong", "v2")).toBe(false);
    expect(await adapter.get("cas_d1")).toBe("v1");

    expect(await adapter.compareAndSwap("cas_d1", "v1", "v2")).toBe(true);
    expect(await adapter.get("cas_d1")).toBe("v2");
  });

  it("filters keys by glob", async () => {
    await adapter.set("edge:sfo", "1");
    await adapter.set("edge:iad", "2");
    await adapter.set("origin:eu", "3");

    const keys = await adapter.keys("edge:*");
    expect(keys.sort()).toEqual(["edge:iad", "edge:sfo"]);
  });

  it("clears table", async () => {
    await adapter.set("k1", "v1");
    await adapter.clear();
    expect(await adapter.get("k1")).toBeNull();
  });
});
