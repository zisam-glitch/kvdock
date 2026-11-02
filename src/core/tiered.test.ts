import { describe, expect, it } from "vitest";
import { MemoryAdapter } from "../adapters/memory/index.js";
import { TieredDock } from "./tiered.js";

describe("TieredDock (L1/L2 Caching Engine)", () => {
  it("serves from L1 when present, falling back to L2 and promoting on L1 miss", async () => {
    const l1 = new MemoryAdapter();
    const l2 = new MemoryAdapter();
    const tiered = new TieredDock({ l1, l2, prefix: "cache" });

    // Populate L2 directly to simulate a populated persistent layer
    await l2.set("cache:user:1", JSON.stringify({ name: "Bob" }));

    // First get: L1 miss, L2 hit -> promoted to L1
    const val1 = await tiered.get<{ name: string }>("user:1");
    expect(val1).toEqual({ name: "Bob" });
    expect(tiered.stats.l1Hits).toBe(0);
    expect(tiered.stats.l2Hits).toBe(1);
    expect(tiered.stats.promotions).toBe(1);

    // Second get: should hit L1 directly
    const val2 = await tiered.get<{ name: string }>("user:1");
    expect(val2).toEqual({ name: "Bob" });
    expect(tiered.stats.l1Hits).toBe(1);
    expect(tiered.stats.hits).toBe(2);
  });

  it("writes to both L1 and L2 on set", async () => {
    const l1 = new MemoryAdapter();
    const l2 = new MemoryAdapter();
    const tiered = new TieredDock({ l1, l2, prefix: "app" });

    await tiered.set("item", "value_1");

    expect(await l1.get("app:item")).toBe(JSON.stringify("value_1"));
    expect(await l2.get("app:item")).toBe(JSON.stringify("value_1"));
  });

  it("deletes from both L1 and L2", async () => {
    const l1 = new MemoryAdapter();
    const l2 = new MemoryAdapter();
    const tiered = new TieredDock({ l1, l2 });

    await tiered.set("remove_me", 100);
    expect(await tiered.has("remove_me")).toBe(true);

    const deleted = await tiered.delete("remove_me");
    expect(deleted).toBe(true);
    expect(await tiered.has("remove_me")).toBe(false);
  });

  it("deduplicates concurrent getOrSet calls to prevent stampedes", async () => {
    const l1 = new MemoryAdapter();
    const l2 = new MemoryAdapter();
    const tiered = new TieredDock({ l1, l2 });

    let fetchCount = 0;
    const fetcher = async () => {
      fetchCount++;
      await new Promise((r) => setTimeout(r, 25));
      return { loaded: true };
    };

    // 10 concurrent requests for same key
    const results = await Promise.all(
      Array.from({ length: 10 }, () => tiered.getOrSet("heavy:computation", fetcher)),
    );

    expect(fetchCount).toBe(1);
    for (const r of results) {
      expect(r).toEqual({ loaded: true });
    }
    expect(tiered.stats.stampedeCoalesced).toBe(9);
  });
});
