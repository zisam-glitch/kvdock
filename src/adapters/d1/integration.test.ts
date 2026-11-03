import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defineAdapterTestSuite } from "../../testing/index.js";
import { D1Adapter, type D1DatabaseLike } from "./index.js";

describe("D1Adapter (Miniflare D1 Integration)", { timeout: 20000 }, () => {
  let mf: Miniflare;
  let d1: D1DatabaseLike;
  let adapter: D1Adapter;
  const tableName = "integ_d1_kvdock";

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response(null); } }",
      d1Databases: ["INTEG_D1"],
    });
    d1 = (await mf.getD1Database("INTEG_D1")) as unknown as D1DatabaseLike;
    const rawD1 = d1 as unknown as { exec: (sql: string) => Promise<void> };
    await rawD1.exec(
      `CREATE TABLE IF NOT EXISTS "${tableName}" (key TEXT PRIMARY KEY, value TEXT, expires_at INTEGER);`,
    );
    adapter = new D1Adapter({ db: d1, tableName });
  });

  afterAll(async () => {
    if (mf) {
      await mf.dispose();
    }
  });

  defineAdapterTestSuite({
    name: "D1Adapter (Miniflare D1)",
    createAdapter: () => adapter,
    supportsTTL: false, // 50ms test is prone to IPC latency race condition; realistic TTL tested below
    teardown: async (a) => {
      await a.clear();
    },
  });

  it("handles realistic ttl expiration over IPC boundary", async () => {
    await adapter.set("timed_ipc", "secret", { ttl: 600 });
    expect(await adapter.get("timed_ipc")).toBe("secret");

    await new Promise((r) => setTimeout(r, 700));
    expect(await adapter.get("timed_ipc")).toBeNull();
  });

  it("handles atomic compareAndSwap across D1 transactions", async () => {
    expect(await adapter.compareAndSwap("cas_key", null, "v1")).toBe(true);
    expect(await adapter.get("cas_key")).toBe("v1");

    expect(await adapter.compareAndSwap("cas_key", "wrong", "v2")).toBe(false);
    expect(await adapter.get("cas_key")).toBe("v1");

    expect(await adapter.compareAndSwap("cas_key", "v1", "v2")).toBe(true);
    expect(await adapter.get("cas_key")).toBe("v2");
  });

  it("performs glob pattern scanning and batch deletes", async () => {
    await adapter.set("user:10", "alice");
    await adapter.set("user:20", "bob");
    await adapter.set("org:99", "acme");

    const users = await adapter.keys("user:*");
    expect(users.sort()).toEqual(["user:10", "user:20"]);

    const deleted = await adapter.deleteMany(["user:10", "user:20", "org:99"]);
    expect(deleted).toBe(3);
    expect(await adapter.has("user:10")).toBe(false);
  });
});
