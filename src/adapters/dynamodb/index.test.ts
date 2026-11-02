import { describe, expect, it, vi } from "vitest";
import { DynamoDBAdapter, type DynamoDBClientInterface } from "./index.js";

describe("DynamoDBAdapter", () => {
  it("enforces required configuration", () => {
    expect(
      () =>
        new DynamoDBAdapter({ client: null as unknown as DynamoDBClientInterface, tableName: "" }),
    ).toThrow();
  });

  it("handles get, set, delete, and has with TTL expiration", async () => {
    const table = new Map<string, Record<string, unknown>>();

    const mockClient: DynamoDBClientInterface = {
      get: vi.fn(async (params) => {
        const pk = String(params.Key.pk);
        const item = table.get(pk);
        return { Item: item };
      }),
      put: vi.fn(async (params) => {
        const pk = String(params.Item.pk);
        if (params.ConditionExpression?.includes("attribute_not_exists") && table.has(pk)) {
          throw new Error("ConditionalCheckFailedException");
        }
        if (params.ConditionExpression?.includes("attribute_exists") && !table.has(pk)) {
          throw new Error("ConditionalCheckFailedException");
        }
        table.set(pk, params.Item);
      }),
      delete: vi.fn(async (params) => {
        table.delete(String(params.Key.pk));
      }),
      scan: vi.fn(async () => {
        return { Items: Array.from(table.values()) };
      }),
    };

    const adapter = new DynamoDBAdapter({
      client: mockClient,
      tableName: "AppCacheTable",
      prefix: "tenant:1#",
    });

    await adapter.set("profile", { name: "Antigravity", role: "core" });
    expect(await adapter.has("profile")).toBe(true);

    const doc = await adapter.get<{ name: string; role: string }>("profile");
    expect(doc).toEqual({ name: "Antigravity", role: "core" });

    // Conditional set NX test (should not overwrite)
    await adapter.set("profile", { name: "Hacker" }, { nx: true });
    expect(await adapter.get<{ name: string }>("profile")).toEqual({
      name: "Antigravity",
      role: "core",
    });

    const keys = await adapter.keys();
    expect(keys).toContain("profile");

    expect(await adapter.delete("profile")).toBe(true);
    expect(await adapter.has("profile")).toBe(false);
  });

  it("handles batchGet and batchWrite operations", async () => {
    const table = new Map<string, Record<string, unknown>>();

    const mockClient: DynamoDBClientInterface = {
      get: vi.fn(async () => ({ Item: undefined })),
      put: vi.fn(async (params) => {
        table.set(String(params.Item.pk), params.Item);
      }),
      delete: vi.fn(async (params) => {
        table.delete(String(params.Key.pk));
      }),
      batchGet: vi.fn(async (params) => {
        const keys = params.RequestItems.BatchTable.Keys;
        const responses: Array<Record<string, unknown>> = [];
        for (const k of keys) {
          const item = table.get(String(k.pk));
          if (item) responses.push(item);
        }
        return { Responses: { BatchTable: responses } };
      }),
      batchWrite: vi.fn(async (params) => {
        const reqs = params.RequestItems.BatchTable;
        for (const r of reqs) {
          if (r.DeleteRequest) {
            table.delete(String(r.DeleteRequest.Key.pk));
          }
        }
      }),
    };

    const adapter = new DynamoDBAdapter({
      client: mockClient,
      tableName: "BatchTable",
    });

    await adapter.setMany([
      { key: "item1", value: 100 },
      { key: "item2", value: 200 },
    ]);

    const batch = await adapter.getMany(["item1", "item2", "nonexistent"]);
    expect(batch.get("item1")).toBe(100);
    expect(batch.get("item2")).toBe(200);
    expect(batch.get("nonexistent")).toBeNull();

    const deleted = await adapter.deleteMany(["item1", "item2"]);
    expect(deleted).toBe(2);
  });
});
