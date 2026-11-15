import { describe, expect, it } from "vitest";
import { MemoryAdapter } from "../adapters/memory/index.js";
import { KVDock } from "../core/store.js";
import type { StorageAdapter } from "../core/types.js";
import { runDoctor } from "./doctor.js";

describe("runDoctor", () => {
  it("reports all checks green for a healthy adapter", async () => {
    const dock = new KVDock({ adapter: new MemoryAdapter() });
    const outcome = await runDoctor(dock, { probes: 10 });

    expect(outcome.ok).toBe(true);
    expect(outcome.checks).toHaveLength(4);
    for (const check of outcome.checks) {
      expect(check.ok).toBe(true);
      expect(check.ms).toBeTypeOf("number");
    }
    expect(await dock.keys("kvdock-doctor:*")).toEqual([]);
  });

  it("reports failure when the adapter errors on writes", async () => {
    const failingAdapter: StorageAdapter = {
      name: "stub",
      capabilities: { ttl: false, batch: false, scan: false, cas: false, binary: false },
      get: async () => null,
      set: async () => {
        throw new Error("backend unreachable");
      },
      delete: async () => true,
      has: async () => false,
      clear: async () => {},
      keys: async () => [],
    };
    const dock = new KVDock({ adapter: failingAdapter });

    const outcome = await runDoctor(dock);

    expect(outcome.ok).toBe(false);
    const failed = outcome.checks.filter((check) => !check.ok);
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]?.detail).toBe("backend unreachable");
  });
});
