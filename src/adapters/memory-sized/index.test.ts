import { describe, expect, it } from "vitest";
import { SizedMemoryAdapter } from "./index.js";

describe("SizedMemoryAdapter", () => {
  it("enforces maxBytes limit and evicts LRU entries", async () => {
    // Each key "k1" (2 bytes) + JSON '"val1"' (6 bytes) = 8 bytes
    // Allow budget for approx 2 entries (16 bytes), maxBytes = 20
    const adapter = new SizedMemoryAdapter({ maxBytes: 20 });

    await adapter.set("k1", "val1");
    await adapter.set("k2", "val2");

    expect(await adapter.has("k1")).toBe(true);
    expect(await adapter.has("k2")).toBe(true);

    // Access k1 to make k2 the least recently used
    await adapter.get("k1");

    // Adding k3 forces eviction of k2
    await adapter.set("k3", "val3");

    expect(await adapter.has("k1")).toBe(true);
    expect(await adapter.has("k3")).toBe(true);
    expect(await adapter.has("k2")).toBe(false);
  });

  it("handles TTL and deletion correctly", async () => {
    const adapter = new SizedMemoryAdapter({ maxBytes: 1000 });
    await adapter.set("temp", "foo", { ttl: 20 });

    expect(await adapter.get("temp")).toBe("foo");
    expect(adapter.getByteFootprint()).toBeGreaterThan(0);

    await new Promise((r) => setTimeout(r, 30));
    expect(await adapter.get("temp")).toBeNull();
    expect(adapter.getByteFootprint()).toBe(0);
  });

  it("handles batch and clear operations", async () => {
    const adapter = new SizedMemoryAdapter({ maxBytes: 5000 });

    await adapter.setMany([
      { key: "a", value: { x: 1 } },
      { key: "b", value: { x: 2 } },
    ]);

    const batch = await adapter.getMany(["a", "b", "c"]);
    expect(batch.get("a")).toEqual({ x: 1 });
    expect(batch.get("b")).toEqual({ x: 2 });
    expect(batch.get("c")).toBeNull();

    await adapter.clear();
    expect(adapter.getByteFootprint()).toBe(0);
    expect(await adapter.keys()).toEqual([]);
  });
});
