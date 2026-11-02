import { beforeEach, describe, expect, it, vi } from "vitest";
import { DenoKVAdapter } from "./index.js";

describe("DenoKVAdapter", () => {
  let adapter: DenoKVAdapter;

  beforeEach(() => {
    adapter = new DenoKVAdapter({ prefix: "test_deno" });
  });

  it("stores and retrieves key-value entries", async () => {
    await adapter.set("deploy_id", "deno_edge_99");
    expect(await adapter.get("deploy_id")).toBe("deno_edge_99");
    expect(await adapter.has("deploy_id")).toBe(true);
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
    expect(await adapter.compareAndSwap("cas_deno", null, "v1")).toBe(true);
    expect(await adapter.get("cas_deno")).toBe("v1");

    expect(await adapter.compareAndSwap("cas_deno", "wrong", "v2")).toBe(false);
    expect(await adapter.get("cas_deno")).toBe("v1");

    expect(await adapter.compareAndSwap("cas_deno", "v1", "v2")).toBe(true);
    expect(await adapter.get("cas_deno")).toBe("v2");
  });

  it("filters keys by glob", async () => {
    await adapter.set("fn:auth", "1");
    await adapter.set("fn:pay", "2");
    await adapter.set("cfg:url", "3");

    const keys = await adapter.keys("fn:*");
    expect(keys.sort()).toEqual(["fn:auth", "fn:pay"]);
  });

  it("clears all keys in prefix", async () => {
    await adapter.set("k1", "v1");
    await adapter.clear();
    expect(await adapter.get("k1")).toBeNull();
  });
});
