import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defineAdapterTestSuite } from "../../testing/index.js";
import { RedisAdapter } from "./index.js";

const url = process.env.REDIS_URL;

describe.skipIf(!url)("RedisAdapter against a real Redis (REDIS_URL)", () => {
  let client: Redis;
  const prefix = `kvdock-it:${Date.now()}:`;

  beforeAll(() => {
    client = new Redis(url as string);
  });

  afterAll(async () => {
    if (client) {
      try {
        const keys = await client.keys(`${prefix}*`);
        if (keys.length) await client.del(...keys);
      } catch {
        // ignore
      }
      await client.quit();
    }
  });

  defineAdapterTestSuite({
    name: "RedisAdapter (real redis)",
    createAdapter: () => new RedisAdapter({ client: client as never, prefix }),
    teardown: async (adapter) => {
      // Clean keys without disconnecting the shared client between test cases
      await adapter.clear();
    },
  });

  it("honours real server-side TTL", async () => {
    const adapter = new RedisAdapter({ client: client as never, prefix });
    await adapter.set("ttl-key", "v", { ttl: 150 });
    expect(await adapter.get("ttl-key")).toBe("v");
    await new Promise((r) => setTimeout(r, 300));
    expect(await adapter.get("ttl-key")).toBeNull();
  });
});
