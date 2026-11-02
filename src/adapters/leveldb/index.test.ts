import { describe, expect, it, vi } from "vitest";
import { defineAdapterTestSuite } from "../../testing/index.js";
import {
  type LevelBatchOperation,
  LevelDBAdapter,
  type LevelDatabaseInterface,
  createMemoryLevelDB,
} from "./index.js";

// Run compliance suite against default LevelDBAdapter
defineAdapterTestSuite({
  name: "LevelDBAdapter",
  createAdapter: () => new LevelDBAdapter(),
});

describe("LevelDBAdapter Batch Writes & Mutations", () => {
  it("executes batch writes using LevelDB batch mutation array", async () => {
    const executedBatches: LevelBatchOperation[][] = [];
    const memory = new Map<string, string>();

    const mockDb: LevelDatabaseInterface = {
      async get(key: string) {
        const val = memory.get(key);
        if (val === undefined) {
          const err = new Error(`Key not found: ${key}`) as Error & { code: string };
          err.code = "LEVEL_NOT_FOUND";
          throw err;
        }
        return val;
      },
      async put(key: string, value: string) {
        memory.set(key, value);
      },
      async del(key: string) {
        memory.delete(key);
      },
      async batch(operations: LevelBatchOperation[]) {
        executedBatches.push(operations);
        for (const op of operations) {
          if (op.type === "put") {
            memory.set(op.key, op.value);
          } else if (op.type === "del") {
            memory.delete(op.key);
          }
        }
      },
      async *keys() {
        for (const k of memory.keys()) {
          yield k;
        }
      },
    };

    const adapter = new LevelDBAdapter({ db: mockDb, prefix: "prod:" });

    await adapter.setMany([
      { key: "item1", value: { id: 1 } },
      { key: "item2", value: { id: 2 } },
    ]);

    expect(executedBatches.length).toBe(1);
    expect(executedBatches[0]).toEqual([
      {
        type: "put",
        key: "prod:item1",
        value: expect.stringContaining('"id":1'),
      },
      {
        type: "put",
        key: "prod:item2",
        value: expect.stringContaining('"id":2'),
      },
    ]);

    // Test batch deletes
    const deletedCount = await adapter.deleteMany(["item1", "item2", "nonexistent"]);
    expect(deletedCount).toBe(2);
    expect(executedBatches.length).toBe(2);
    expect(executedBatches[1]).toEqual([
      { type: "del", key: "prod:item1" },
      { type: "del", key: "prod:item2" },
    ]);
  });
});

describe("LevelDBAdapter Sublevels & Prefix Range Scanning", () => {
  it("isolates data across multiple sublevel namespaces", async () => {
    const rootAdapter = new LevelDBAdapter();

    const usersSub = rootAdapter.sublevel("users");
    const sessionsSub = rootAdapter.sublevel("sessions");

    await usersSub.set("101", { name: "Alice" });
    await sessionsSub.set("101", { active: true });

    expect(await usersSub.get("101")).toEqual({ name: "Alice" });
    expect(await sessionsSub.get("101")).toEqual({ active: true });

    const userKeys = await usersSub.keys();
    expect(userKeys).toEqual(["101"]);

    const sessionKeys = await sessionsSub.keys();
    expect(sessionKeys).toEqual(["101"]);
  });

  it("performs prefix range scanning using scanSublevel", async () => {
    const rootAdapter = new LevelDBAdapter();
    const analyticsSub = rootAdapter.sublevel("analytics");

    await analyticsSub.set("page:home", { hits: 10 });
    await analyticsSub.set("page:pricing", { hits: 5 });
    await analyticsSub.set("event:click", { hits: 2 });

    const scannedKeys: string[] = [];
    for await (const k of rootAdapter.scanSublevel("analytics", "page:*")) {
      scannedKeys.push(k);
    }

    expect(scannedKeys.sort()).toEqual(["analytics:page:home", "analytics:page:pricing"]);
  });

  it("supports nested sublevels", async () => {
    const rootAdapter = new LevelDBAdapter();
    const tenantA = rootAdapter.sublevel("tenantA");
    const tenantACache = tenantA.sublevel("cache");

    await tenantACache.set("cfg", { theme: "dark" });
    expect(await tenantACache.get("cfg")).toEqual({ theme: "dark" });
    expect(await tenantA.has("cfg")).toBe(false);
  });
});

describe("LevelDBAdapter Error Handling & CAS", () => {
  it("handles LEVEL_NOT_FOUND and missing keys gracefully", async () => {
    const mockDb: LevelDatabaseInterface = {
      async get() {
        const error = new Error("Key not found in database") as Error & { notFound: boolean };
        error.notFound = true;
        throw error;
      },
      async put() {},
      async del() {},
      async batch() {},
      async *keys() {},
    };

    const adapter = new LevelDBAdapter({ db: mockDb });
    expect(await adapter.get("missing")).toBeNull();
    expect(await adapter.has("missing")).toBe(false);
    expect(await adapter.delete("missing")).toBe(false);
  });

  it("handles atomic compareAndSwap semantics", async () => {
    const adapter = new LevelDBAdapter();

    await adapter.set("counter", 1);
    const swapped = await adapter.compareAndSwap("counter", 1, 2);
    expect(swapped).toBe(true);
    expect(await adapter.get("counter")).toBe(2);

    const failedSwap = await adapter.compareAndSwap("counter", 1, 3);
    expect(failedSwap).toBe(false);
    expect(await adapter.get("counter")).toBe(2);
  });

  it("calls close on disconnect when db supports it", async () => {
    const closeSpy = vi.fn(async () => {});
    const mockDb: LevelDatabaseInterface = {
      ...createMemoryLevelDB(),
      close: closeSpy,
    };

    const adapter = new LevelDBAdapter({ db: mockDb });
    await adapter.disconnect();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
