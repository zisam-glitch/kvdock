import { describe, expect, it } from "vitest";
import { defineAdapterTestSuite } from "../../testing/index.js";
import { MemoryWTinyLFUAdapter } from "./index.js";

describe("MemoryWTinyLFUAdapter", () => {
  defineAdapterTestSuite({
    name: "MemoryWTinyLFUAdapter",
    createAdapter: () => new MemoryWTinyLFUAdapter({ maxSize: 100 }),
    supportsTTL: true,
  });

  describe("W-TinyLFU Eviction and Frequency Behavior", () => {
    it("protects high-frequency keys against scan / one-hit wonder pollution", async () => {
      // Small cache of capacity 10
      const adapter = new MemoryWTinyLFUAdapter({ maxSize: 10 });

      // Build high frequency for "frequent_key"
      await adapter.set("frequent_key", "frequent_val");
      for (let i = 0; i < 15; i++) {
        await adapter.get("frequent_key");
      }

      // Populate other keys to fill cache
      for (let i = 0; i < 9; i++) {
        await adapter.set(`key_${i}`, `val_${i}`);
      }

      // Flood cache with 30 distinct one-hit wonder keys (simulating a database scan)
      for (let i = 0; i < 30; i++) {
        await adapter.set(`scan_key_${i}`, `scan_val_${i}`);
      }

      // W-TinyLFU should preserve "frequent_key" while evicting cold/scan items
      expect(await adapter.get("frequent_key")).toBe("frequent_val");
    });

    it("promotes items from probation to protected segment on subsequent access", async () => {
      const adapter = new MemoryWTinyLFUAdapter({ maxSize: 10 });

      await adapter.set("promo_key", "promo_val");
      // Access once in window, pushes candidate into probation when window overflows
      await adapter.get("promo_key");

      for (let i = 0; i < 5; i++) {
        await adapter.set(`extra_${i}`, `extra_val_${i}`);
      }

      // Accessing again promotes from probation to protected
      expect(await adapter.get("promo_key")).toBe("promo_val");
    });
  });
});
