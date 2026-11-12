import { describe, expect, it } from "vitest";
import { MemoryAdapter } from "../adapters/memory/index.js";
import { KVDock } from "../core/store.js";
import {
  createSnapshot,
  exportSnapshotToJSON,
  importSnapshotFromJSON,
  restoreSnapshot,
} from "./snapshot.js";

describe("Snapshot Tooling", () => {
  it("creates, exports, imports, and restores snapshots across stores", async () => {
    const sourceAdapter = new MemoryAdapter();
    const sourceDock = new KVDock({ adapter: sourceAdapter });

    await sourceDock.set("config:theme", "dark");
    await sourceDock.set("config:language", "en-US");
    await sourceDock.set("user:101", { name: "Alice", role: "admin" });

    // 1. Create snapshot
    const snapshot = await createSnapshot(sourceDock, {
      metadata: { environment: "production" },
    });

    expect(snapshot.version).toBe(1);
    expect(snapshot.entryCount).toBe(3);
    expect(snapshot.metadata).toEqual({ environment: "production" });

    // 2. Export to JSON string and import back
    const jsonStr = exportSnapshotToJSON(snapshot, true);
    expect(jsonStr).toContain('"version": 1');

    const importedSnapshot = importSnapshotFromJSON(jsonStr);
    expect(importedSnapshot.entries).toHaveLength(3);

    // 3. Restore into clean target store
    const targetAdapter = new MemoryAdapter();
    const targetDock = new KVDock({ adapter: targetAdapter });

    const stats = await restoreSnapshot(targetDock, importedSnapshot, {
      keyPrefix: "backup:",
    });

    expect(stats.total).toBe(3);
    expect(stats.restored).toBe(3);
    expect(stats.skipped).toBe(0);

    // 4. Verify target contents
    expect(await targetDock.get("backup:config:theme")).toBe("dark");
    expect(await targetDock.get("backup:user:101")).toEqual({ name: "Alice", role: "admin" });
  });

  it("respects prefix filtering and overwrite=false", async () => {
    const source = new MemoryAdapter();
    await source.set("app:a", "1");
    await source.set("app:b", "2");
    await source.set("other:c", "3");

    const snapshot = await createSnapshot(source, { prefix: "app:" });
    expect(snapshot.entryCount).toBe(2);

    const target = new MemoryAdapter();
    await target.set("app:a", "existing_val");

    const stats = await restoreSnapshot(target, snapshot, { overwrite: false });
    expect(stats.restored).toBe(1);
    expect(stats.skipped).toBe(1);
    expect(await target.get("app:a")).toBe("existing_val");
  });
});
