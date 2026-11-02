import { describe, expect, it, vi } from "vitest";
import {
  ValkeyClusterAdapter,
  type ValkeyClusterClient,
  type ValkeyNodeClient,
  calculateSlot,
} from "./index.js";

describe("calculateSlot", () => {
  it("computes crc16 slot without hash tags", () => {
    const slot = calculateSlot("user:1000");
    expect(slot).toBeGreaterThanOrEqual(0);
    expect(slot).toBeLessThan(16384);
  });

  it("computes identical slot for keys sharing a hash tag", () => {
    const slot1 = calculateSlot("{tenant1}:profile");
    const slot2 = calculateSlot("{tenant1}:settings");
    const slot3 = calculateSlot("{tenant2}:profile");

    expect(slot1).toBe(slot2);
    expect(slot1).not.toBe(slot3);
  });
});

describe("ValkeyClusterAdapter", () => {
  it("performs get, set, delete, and has with prefix and hash tags", async () => {
    const db = new Map<string, string>();

    const mockClient: ValkeyClusterClient = {
      getNodeForKey: vi.fn(),
      getNodeByAddress: vi.fn(),
      getAllNodes: () => [],
      get: vi.fn(async (key: string) => db.get(key) ?? null),
      set: vi.fn(async (key: string, val: string) => {
        db.set(key, val);
        return "OK";
      }),
      del: vi.fn(async (key: string) => (db.delete(key) ? 1 : 0)),
      exists: vi.fn(async (key: string) => (db.has(key) ? 1 : 0)),
      keys: vi.fn(async () => Array.from(db.keys())),
    };

    const adapter = new ValkeyClusterAdapter({
      client: mockClient,
      prefix: "myapp",
      useHashTags: true,
    });

    await adapter.set("config", { env: "production", retries: 3 });
    expect(await adapter.has("config")).toBe(true);

    const val = await adapter.get<{ env: string; retries: number }>("config");
    expect(val).toEqual({ env: "production", retries: 3 });

    expect(await adapter.delete("config")).toBe(true);
    expect(await adapter.has("config")).toBe(false);
  });

  it("handles MOVED redirection correctly", async () => {
    const targetDb = new Map<string, string>();
    targetDb.set("routed-key", JSON.stringify("target-node-value"));

    const targetNode: ValkeyNodeClient = {
      get: vi.fn(async (k: string) => targetDb.get(k) ?? null),
      set: vi.fn(),
      del: vi.fn(),
      exists: vi.fn(),
      keys: vi.fn(),
    };

    const mockCluster: ValkeyClusterClient = {
      getNodeForKey: vi.fn(),
      getNodeByAddress: vi.fn((addr: string) =>
        addr === "127.0.0.1:7001" ? targetNode : undefined,
      ),
      getAllNodes: () => [targetNode],
      get: vi.fn(async () => {
        throw new Error("MOVED 3999 127.0.0.1:7001");
      }),
      set: vi.fn(),
      del: vi.fn(),
      exists: vi.fn(),
      keys: vi.fn(),
    };

    const adapter = new ValkeyClusterAdapter({
      client: mockCluster,
    });

    const result = await adapter.get<string>("routed-key");
    expect(result).toBe("target-node-value");
    expect(targetNode.get).toHaveBeenCalledWith("routed-key");
  });

  it("falls back gracefully on cross-slot batch getMany", async () => {
    const db = new Map<string, string>([
      ["{tenant}:k1", JSON.stringify(10)],
      ["{tenant}:k2", JSON.stringify(20)],
    ]);

    const mockCluster: ValkeyClusterClient = {
      getNodeForKey: vi.fn(),
      getNodeByAddress: vi.fn(),
      getAllNodes: () => [],
      get: vi.fn(async (k: string) => db.get(k) ?? null),
      set: vi.fn(),
      del: vi.fn(),
      exists: vi.fn(),
      keys: vi.fn(),
      mget: vi.fn(async () => {
        throw new Error("CROSSSLOT Keys in request don't hash to the same slot");
      }),
    };

    const adapter = new ValkeyClusterAdapter({
      client: mockCluster,
      prefix: "tenant",
      useHashTags: true,
    });

    const batch = await adapter.getMany(["k1", "k2", "missing"]);
    expect(batch.get("k1")).toBe(10);
    expect(batch.get("k2")).toBe(20);
    expect(batch.get("missing")).toBeNull();
  });
});
