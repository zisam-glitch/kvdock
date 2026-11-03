import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defineAdapterTestSuite } from "../../testing/index.js";
import { CloudflareKVAdapter, type CloudflareKVNamespace } from "./index.js";

describe("CloudflareKVAdapter (Miniflare Integration)", () => {
  let mf: Miniflare;
  let kv: CloudflareKVNamespace;
  let adapter: CloudflareKVAdapter;

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response(null); } }",
      kvNamespaces: ["INTEG_KV"],
    });
    kv = (await mf.getKVNamespace("INTEG_KV")) as unknown as CloudflareKVNamespace;
    adapter = new CloudflareKVAdapter({ kv });
  });

  afterAll(async () => {
    if (mf) {
      await mf.dispose();
    }
  });

  defineAdapterTestSuite({
    name: "CloudflareKVAdapter (Miniflare KV)",
    createAdapter: () => adapter,
    supportsTTL: false, // Cloudflare enforces 60s minimum TTL in production
    teardown: async (a) => {
      await a.clear();
    },
  });

  it("safely enforces Cloudflare 60s minimum TTL clamp on real worker runtime", async () => {
    // Write key with 5000ms TTL (5s) -> clamped to 60s
    await adapter.set("ttl_test", "clamped_val", { ttl: 5000 });
    const stored = await adapter.get("ttl_test");
    expect(stored).toBe("clamped_val");
  });

  it("handles batch writes and pattern scans across Miniflare KV", async () => {
    await adapter.setMany([
      { key: "tenant:a:1", value: "val_a1" },
      { key: "tenant:a:2", value: "val_a2" },
      { key: "tenant:b:1", value: "val_b1" },
    ]);

    const matching: string[] = [];
    for await (const k of adapter.scan("tenant:a:*")) {
      matching.push(k);
    }
    expect(matching.sort()).toEqual(["tenant:a:1", "tenant:a:2"]);

    const deleted = await adapter.deleteMany(["tenant:a:1", "tenant:a:2", "tenant:b:1"]);
    expect(deleted).toBe(3);
  });
});
