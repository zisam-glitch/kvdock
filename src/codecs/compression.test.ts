import { describe, expect, it } from "vitest";
import { createCompressionCodec } from "./compression.js";

describe("CompressionCodec", () => {
  it("leaves payloads below threshold uncompressed", () => {
    const codec = createCompressionCodec<{ message: string }>({ threshold: 500 });
    const payload = { message: "small message" };
    const encoded = codec.encode(payload);

    expect(encoded).not.toContain("\u0000__GZ__:");
    expect(codec.decode(encoded)).toEqual(payload);
  });

  it("compresses large payloads with gzip above threshold", () => {
    const codec = createCompressionCodec<{ text: string }>({ algorithm: "gzip", threshold: 100 });
    const payload = { text: "repeat-text-data-".repeat(50) };
    const encoded = codec.encode(payload);

    expect(encoded).toContain("\u0000__GZ__:");
    expect(encoded.length).toBeLessThan(JSON.stringify(payload).length);
    expect(codec.decode(encoded)).toEqual(payload);
  });

  it("compresses large payloads with brotli above threshold", () => {
    const codec = createCompressionCodec<{ items: number[] }>({
      algorithm: "brotli",
      threshold: 100,
    });
    const payload = { items: Array.from({ length: 500 }, (_, i) => i) };
    const encoded = codec.encode(payload);

    expect(encoded).toContain("\u0000__BR__:");
    expect(encoded.length).toBeLessThan(JSON.stringify(payload).length);
    expect(codec.decode(encoded)).toEqual(payload);
  });
});
