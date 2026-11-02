import { describe, expect, it } from "vitest";
import { defineAdapterTestSuite } from "../../testing/index.js";
import { CloudflareKVAdapter, type CloudflareKVNamespace } from "./index.js";

class MockKVNamespace implements CloudflareKVNamespace {
  private readonly store = new Map<string, { value: string; expirationTtl?: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    return entry ? entry.value : null;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, { value, expirationTtl: options?.expirationTtl });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
    cursor?: string;
  }> {
    let all = Array.from(this.store.keys());
    const searchPrefix = options?.prefix;
    if (searchPrefix) {
      all = all.filter((k) => k.startsWith(searchPrefix));
    }
    return {
      keys: all.map((name) => ({ name })),
      list_complete: true,
    };
  }
}

defineAdapterTestSuite({
  name: "CloudflareKVAdapter",
  createAdapter: () => new CloudflareKVAdapter({ kv: new MockKVNamespace() }),
  supportsTTL: false, // Cloudflare enforces 60s minimum TTL
});

describe("CloudflareKVAdapter (Edge Specifics)", () => {
  it("enforces minimum 60s expirationTtl clamp for worker safety", async () => {
    let capturedOptions: { expirationTtl?: number } | undefined;
    const mock: CloudflareKVNamespace = {
      async get() {
        return null;
      },
      async put(_k, _v, opts) {
        capturedOptions = opts;
      },
      async delete() {},
      async list() {
        return { keys: [], list_complete: true };
      },
    };

    const adapter = new CloudflareKVAdapter({ kv: mock });
    // 1000ms = 1s, should be clamped to 60s
    await adapter.set("key", "val", { ttl: 1000 });
    expect(capturedOptions?.expirationTtl).toBe(60);

    // 120_000ms = 120s, should be preserved
    await adapter.set("key", "val", { ttl: 120_000 });
    expect(capturedOptions?.expirationTtl).toBe(120);
  });
});
