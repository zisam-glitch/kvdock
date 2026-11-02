import { describe, expect, it } from "vitest";
import { MemoryAdapter } from "../adapters/memory/index.js";
import { KVDock } from "../core/store.js";
import { createCompressionCodec } from "./compression.js";

describe("Compression Codec", () => {
  it("compresses large payloads exceeding threshold", async () => {
    const memory = new MemoryAdapter();
    const codec = createCompressionCodec({
      algorithm: "brotli",
      thresholdBytes: 100,
    });

    const dock = new KVDock({
      adapter: memory,
      serializer: codec,
    });

    const largeData = {
      description: "A".repeat(5000),
      items: Array.from({ length: 100 }, (_, i) => ({ id: i, name: `item_${i}` })),
    };

    await dock.set("large:key", largeData);

    // Inspect stored raw payload in adapter directly
    const rawStored = await memory.get("large:key");
    expect(typeof rawStored).toBe("string");
    expect((rawStored as string).startsWith("__kvc_br::")).toBe(true);
    // Raw stored string must be significantly smaller than uncompressed JSON
    expect((rawStored as string).length).toBeLessThan(JSON.stringify(largeData).length / 2);

    // Read back through dock
    const retrieved = await dock.get<typeof largeData>("large:key");
    expect(retrieved).toEqual(largeData);
  });

  it("leaves small payloads under threshold uncompressed", async () => {
    const memory = new MemoryAdapter();
    const codec = createCompressionCodec({
      algorithm: "gzip",
      thresholdBytes: 1000,
    });

    const dock = new KVDock({
      adapter: memory,
      serializer: codec,
    });

    const smallData = { greeting: "hello world" };
    await dock.set("small:key", smallData);

    const rawStored = await memory.get("small:key");
    expect((rawStored as string).startsWith("__kvc_raw::")).toBe(true);

    const retrieved = await dock.get("small:key");
    expect(retrieved).toEqual(smallData);
  });

  it("supports deflate algorithm and handles legacy uncompressed records", async () => {
    const memory = new MemoryAdapter();
    const codec = createCompressionCodec({
      algorithm: "deflate",
      thresholdBytes: 50,
    });

    const dock = new KVDock({
      adapter: memory,
      serializer: codec,
    });

    const payload = { text: "repeatable text ".repeat(50) };
    await dock.set("deflate:key", payload);

    const raw = await memory.get("deflate:key");
    expect((raw as string).startsWith("__kvc_df::")).toBe(true);

    const result = await dock.get("deflate:key");
    expect(result).toEqual(payload);

    // Test legacy un-prefixed payload deserialization fallback
    await memory.set("legacy:key", JSON.stringify({ legacy: true }));
    const legacy = await dock.get("legacy:key");
    expect(legacy).toEqual({ legacy: true });
  });
});
