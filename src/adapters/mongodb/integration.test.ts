import { MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defineAdapterTestSuite } from "../../testing/index.js";
import { type MongoCollectionLike, MongoDBAdapter } from "./index.js";

const uri = process.env.MONGODB_URI;

describe.skipIf(!uri)("MongoDBAdapter against a real MongoDB (MONGODB_URI)", () => {
  let client: MongoClient;
  let collection: MongoCollectionLike;
  const dbName = `kvdock_it_${Date.now()}`;

  beforeAll(async () => {
    client = new MongoClient(uri as string);
    await client.connect();
    const db = client.db(dbName);
    collection = db.collection("cache") as unknown as MongoCollectionLike;
  });

  afterAll(async () => {
    if (client) {
      try {
        await client.db(dbName).dropDatabase();
      } catch {
        // ignore
      }
      await client.close();
    }
  });

  defineAdapterTestSuite({
    name: "MongoDBAdapter (real mongodb)",
    createAdapter: () => new MongoDBAdapter({ collection }),
    teardown: async (adapter) => {
      await adapter.clear();
    },
  });

  it("handles atomic compareAndSwap on real mongo document", async () => {
    const adapter = new MongoDBAdapter({ collection });
    expect(await adapter.compareAndSwap("cas:mongo", null, "val1")).toBe(true);
    expect(await adapter.get("cas:mongo")).toBe("val1");
    expect(await adapter.compareAndSwap("cas:mongo", "wrong", "val2")).toBe(false);
    expect(await adapter.compareAndSwap("cas:mongo", "val1", "val2")).toBe(true);
    expect(await adapter.get("cas:mongo")).toBe("val2");
  });
});
