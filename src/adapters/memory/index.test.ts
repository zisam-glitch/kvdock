import { describe, expect, it } from "vitest";
import { defineAdapterTestSuite } from "../../testing/index.js";
import { MemoryAdapter } from "./index.js";

defineAdapterTestSuite({
  name: "MemoryAdapter",
  createAdapter: () => new MemoryAdapter(),
});

describe("MemoryAdapter (LRU & In-Memory specifics)", () => {
  it("stores and retrieves basic values", async () => {
    const adapter = new MemoryAdapter();
    await adapter.set("foo", "bar");

    expect(await adapter.get("foo")).toBe("bar");
    expect(await adapter.has("foo")).toBe(true);

    await adapter.delete("foo");
    expect(await adapter.get("foo")).toBeNull();
    expect(await adapter.has("foo")).toBe(false);
  });

  it("honors ttl expiration", async () => {
    const adapter = new MemoryAdapter();
    await adapter.set("temp", "val", { ttl: 20 });

    expect(await adapter.get("temp")).toBe("val");

    await new Promise((r) => setTimeout(r, 35));
    expect(await adapter.get("temp")).toBeNull();
  });

  it("evicts oldest entry on reaching maxSize", async () => {
    const adapter = new MemoryAdapter({ maxSize: 2 });
    await adapter.set("a", "1");
    await adapter.set("b", "2");

    // access 'a' to refresh lru order -> 'b' is now oldest
    await adapter.get("a");

    await adapter.set("c", "3");

    expect(await adapter.get("a")).toBe("1");
    expect(await adapter.get("c")).toBe("3");
    expect(await adapter.get("b")).toBeNull();
  });

  it("handles conditional writes (nx/xx)", async () => {
    const adapter = new MemoryAdapter();

    await adapter.set("k", "v1", { xx: true });
    expect(await adapter.get("k")).toBeNull();

    await adapter.set("k", "v1", { nx: true });
    expect(await adapter.get("k")).toBe("v1");

    await adapter.set("k", "v2", { nx: true });
    expect(await adapter.get("k")).toBe("v1");

    await adapter.set("k", "v2", { xx: true });
    expect(await adapter.get("k")).toBe("v2");
  });

  it("filters keys by pattern", async () => {
    const adapter = new MemoryAdapter();
    await adapter.set("user:1", "a");
    await adapter.set("user:2", "b");
    await adapter.set("post:1", "c");

    const userKeys = await adapter.keys("user:*");
    expect(userKeys.sort()).toEqual(["user:1", "user:2"]);
  });
});
