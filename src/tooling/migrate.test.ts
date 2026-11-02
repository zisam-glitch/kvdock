import { describe, expect, it, vi } from "vitest";
import { MemoryAdapter } from "../adapters/memory/index.js";
import { KVDock } from "../core/store.js";
import { type MigrationProgress, migrate } from "./migrate.js";

describe("migrate tooling", () => {
  it("migrates all keys and values from source to target", async () => {
    const source = new MemoryAdapter();
    const target = new MemoryAdapter();

    for (let i = 0; i < 50; i++) {
      await source.set(`user:${i}`, JSON.stringify({ id: i, name: `User ${i}` }));
    }

    const progressUpdates: MigrationProgress[] = [];
    const stats = await migrate({
      source,
      target,
      batchSize: 10,
      concurrency: 3,
      onProgress: (p) => progressUpdates.push({ ...p }),
    });

    expect(stats.total).toBe(50);
    expect(stats.copied).toBe(50);
    expect(stats.failed).toBe(0);
    expect(stats.skipped).toBe(0);

    for (let i = 0; i < 50; i++) {
      const raw = await target.get<string>(`user:${i}`);
      expect(JSON.parse(raw ?? "{}")).toEqual({ id: i, name: `User ${i}` });
    }

    expect(progressUpdates.length).toBeGreaterThan(0);
    expect(progressUpdates[progressUpdates.length - 1].copied).toBe(50);
  });

  it("applies key and value transformations during migration", async () => {
    const source = new MemoryAdapter();
    const target = new MemoryAdapter();

    await source.set("keep:1", JSON.stringify({ count: 10 }));
    await source.set("skip:2", JSON.stringify({ count: 20 }));
    await source.set("keep:3", JSON.stringify({ count: 30 }));

    const stats = await migrate({
      source,
      target,
      transformKey: (k) => (k.startsWith("keep:") ? `v2:${k}` : null),
      transformValue: (v: unknown) => {
        const parsed = JSON.parse(v as string);
        return JSON.stringify({ ...parsed, migrated: true });
      },
    });

    expect(stats.total).toBe(3);
    expect(stats.copied).toBe(2);
    expect(stats.skipped).toBe(1);

    expect(await target.has("v2:keep:1")).toBe(true);
    const targetVal = await target.get<string>("v2:keep:1");
    expect(JSON.parse(targetVal ?? "{}")).toEqual({ count: 10, migrated: true });
    expect(await target.has("skip:2")).toBe(false);
    expect(await target.has("v2:skip:2")).toBe(false);
  });

  it("respects overwrite: false", async () => {
    const source = new MemoryAdapter();
    const target = new MemoryAdapter();

    await source.set("key:1", "source-val");
    await target.set("key:1", "target-val");

    const stats = await migrate({
      source,
      target,
      overwrite: false,
    });

    expect(stats.skipped).toBe(1);
    expect(stats.copied).toBe(0);
    expect(await target.get("key:1")).toBe("target-val");
  });

  it("works seamlessly between KVDock instances", async () => {
    const sourceDock = new KVDock({ adapter: new MemoryAdapter(), prefix: "src:" });
    const targetDock = new KVDock({ adapter: new MemoryAdapter(), prefix: "dst:" });

    await sourceDock.set("config:theme", "dark");
    await sourceDock.set("config:locale", "en-US");

    const stats = await migrate({
      source: sourceDock,
      target: targetDock,
    });

    expect(stats.copied).toBe(2);
    expect(await targetDock.get("config:theme")).toBe("dark");
    expect(await targetDock.get("config:locale")).toBe("en-US");
  });

  it("handles retry and error recording for failing keys", async () => {
    const source = new MemoryAdapter();
    const target = new MemoryAdapter();

    await source.set("ok:1", "data");
    await source.set("fail:1", "data");

    // Mock target.set failure on fail:1
    const originalSet = target.set.bind(target);
    vi.spyOn(target, "set").mockImplementation(async (key, val, opts) => {
      if (key === "fail:1") {
        throw new Error("Disk write error");
      }
      return originalSet(key, val, opts);
    });

    const stats = await migrate({
      source,
      target,
      retries: 2,
      retryDelayMs: 5,
    });

    expect(stats.copied).toBe(1);
    expect(stats.failed).toBe(1);
    expect(stats.errors).toHaveLength(1);
    expect(stats.errors[0]).toEqual({ key: "fail:1", error: "Disk write error" });
  });
});
