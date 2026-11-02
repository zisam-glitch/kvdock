import { describe, expect, it, vi } from "vitest";
import { S3Adapter, type S3ClientInterface } from "./index.js";

describe("S3Adapter", () => {
  it("enforces required configuration", () => {
    expect(
      () => new S3Adapter({ client: null as unknown as S3ClientInterface, bucket: "" }),
    ).toThrow();
  });

  it("performs get, set, delete, and has with metadata expiration", async () => {
    const store = new Map<string, { body: string; metadata?: Record<string, string> }>();

    const mockS3: S3ClientInterface = {
      getObject: vi.fn(async (params) => {
        const item = store.get(params.Key);
        if (!item) return null;
        return { Body: item.body, Metadata: item.metadata };
      }),
      putObject: vi.fn(async (params) => {
        store.set(params.Key, {
          body:
            typeof params.Body === "string" ? params.Body : new TextDecoder().decode(params.Body),
          metadata: params.Metadata,
        });
      }),
      deleteObject: vi.fn(async (params) => {
        store.delete(params.Key);
      }),
      headObject: vi.fn(async (params) => {
        const item = store.get(params.Key);
        if (!item) return null;
        return { Metadata: item.metadata };
      }),
      listObjectsV2: vi.fn(async (params) => {
        const keys = Array.from(store.keys()).filter((k) =>
          params.Prefix ? k.startsWith(params.Prefix) : true,
        );
        return { Contents: keys.map((k) => ({ Key: k })) };
      }),
    };

    const adapter = new S3Adapter({
      client: mockS3,
      bucket: "my-cache-bucket",
      prefix: "blobs/",
    });

    await adapter.set("document", { title: "Architecture", pages: 42 });
    expect(await adapter.has("document")).toBe(true);

    const doc = await adapter.get<{ title: string; pages: number }>("document");
    expect(doc).toEqual({ title: "Architecture", pages: 42 });

    const keys = await adapter.keys();
    expect(keys).toContain("document");

    expect(await adapter.delete("document")).toBe(true);
    expect(await adapter.has("document")).toBe(false);
  });

  it("handles batch operations", async () => {
    const store = new Map<string, { body: string; metadata?: Record<string, string> }>();

    const mockS3: S3ClientInterface = {
      getObject: vi.fn(async (params) => {
        const item = store.get(params.Key);
        return item ? { Body: item.body } : null;
      }),
      putObject: vi.fn(async (params) => {
        store.set(params.Key, { body: String(params.Body) });
      }),
      deleteObject: vi.fn(async (params) => {
        store.delete(params.Key);
      }),
      deleteObjects: vi.fn(async (params) => {
        for (const obj of params.Delete.Objects) {
          store.delete(obj.Key);
        }
        return { Deleted: params.Delete.Objects };
      }),
    };

    const adapter = new S3Adapter({
      client: mockS3,
      bucket: "bulk-bucket",
    });

    await adapter.setMany([
      { key: "f1", value: "content1" },
      { key: "f2", value: "content2" },
    ]);

    const batch = await adapter.getMany(["f1", "f2", "f3"]);
    expect(batch.get("f1")).toBe("content1");
    expect(batch.get("f2")).toBe("content2");
    expect(batch.get("f3")).toBeNull();

    const deleted = await adapter.deleteMany(["f1", "f2"]);
    expect(deleted).toBe(2);
  });
});
