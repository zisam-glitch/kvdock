import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineAdapterTestSuite } from "../../testing/index.js";
import { FsAdapter } from "./index.js";

defineAdapterTestSuite({
  name: "FsAdapter",
  createAdapter: async () => {
    const dir = await mkdtemp(join(tmpdir(), "kvdock-fs-suite-"));
    return new FsAdapter({ dir });
  },
});

describe("FsAdapter", () => {
  let tempDir: string;
  let adapter: FsAdapter;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kvdock-test-"));
    adapter = new FsAdapter({ dir: tempDir });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("persists values across adapter instances", async () => {
    await adapter.set("persistent-key", "saved-data");

    const secondInstance = new FsAdapter({ dir: tempDir });
    expect(await secondInstance.get("persistent-key")).toBe("saved-data");
    expect(await secondInstance.has("persistent-key")).toBe(true);
  });

  it("deletes file on key expiry", async () => {
    await adapter.set("ephemeral", "bye", { ttl: 60 });
    expect(await adapter.get("ephemeral")).toBe("bye");

    await new Promise((r) => setTimeout(r, 80));
    expect(await adapter.get("ephemeral")).toBeNull();
  });

  it("lists and pattern matches persisted keys", async () => {
    await adapter.set("cfg:app", "1");
    await adapter.set("cfg:db", "2");
    await adapter.set("cache:user", "3");

    const cfgKeys = await adapter.keys("cfg:*");
    expect(cfgKeys.sort()).toEqual(["cfg:app", "cfg:db"]);
  });

  it("handles long keys and special URI characters with shard indexing", async () => {
    const longKey = `${"a/b/c/".repeat(30)}final-deeply-nested-key`;
    await adapter.set(longKey, "deep_data");
    expect(await adapter.get(longKey)).toBe("deep_data");
    expect(await adapter.has(longKey)).toBe(true);

    const keys = await adapter.keys();
    expect(keys).toContain(longKey);
  });

  it("handles atomic file replacement under concurrent writers without corruption", async () => {
    const writers = Array.from({ length: 20 }, (_, i) =>
      adapter.set("hot_concurrent_key", `writer_${i}`),
    );
    await Promise.all(writers);

    const finalVal = await adapter.get<string>("hot_concurrent_key");
    expect(finalVal).toMatch(/^writer_\d+$/);
  });
});
