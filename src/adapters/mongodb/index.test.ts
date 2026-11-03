import { beforeEach, describe, expect, it } from "vitest";
import { defineAdapterTestSuite } from "../../testing/index.js";
import { MockMongoCollection, MongoDBAdapter } from "./index.js";

defineAdapterTestSuite({
  name: "MongoDBAdapter (MockMongoCollection)",
  createAdapter: () => new MongoDBAdapter({ collection: new MockMongoCollection() }),
});

describe("MongoDBAdapter specifics", () => {
  let adapter: MongoDBAdapter;
  let mockCollection: MockMongoCollection;

  beforeEach(() => {
    mockCollection = new MockMongoCollection();
    adapter = new MongoDBAdapter({ collection: mockCollection });
  });

  it("handles atomic CAS concurrency", async () => {
    await adapter.set("doc_val", "initial");

    // Success CAS
    const success = await adapter.compareAndSwap("doc_val", "initial", "updated");
    expect(success).toBe(true);
    expect(await adapter.get("doc_val")).toBe("updated");

    // Stale CAS
    const fail = await adapter.compareAndSwap("doc_val", "initial", "again");
    expect(fail).toBe(false);
    expect(await adapter.get("doc_val")).toBe("updated");
  });

  it("handles CAS on uninitialized key with null expected", async () => {
    const success = await adapter.compareAndSwap("missing_doc", null, "created");
    expect(success).toBe(true);
    expect(await adapter.get("missing_doc")).toBe("created");

    // Fails on existing
    const fail = await adapter.compareAndSwap("missing_doc", null, "another");
    expect(fail).toBe(false);
  });

  it("honors TTL remaining duration", async () => {
    await adapter.set("timed_key", "timed_val", { ttl: 5000 });
    const remaining = await adapter.ttl("timed_key");
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(5000);
  });

  it("returns null TTL for persistent keys", async () => {
    await adapter.set("persistent", "val");
    expect(await adapter.ttl("persistent")).toBeNull();
  });

  it("filters keys by glob patterns", async () => {
    await adapter.set("user:1", "Alice");
    await adapter.set("user:2", "Bob");
    await adapter.set("order:1", "100");

    const userKeys = await adapter.keys("user:*");
    expect(userKeys.sort()).toEqual(["user:1", "user:2"]);
  });
});
