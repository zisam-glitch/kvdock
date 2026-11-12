import { bench, describe } from "vitest";
import { createCompressionCodec } from "../src/codecs/compression.js";

const payload1KB = {
  id: 1,
  user: "benchmark-user",
  data: "x".repeat(1024),
  tags: ["cache", "kvdock"],
};

const payload10KB = {
  id: 2,
  user: "benchmark-user-large",
  data: "x".repeat(10 * 1024),
  tags: ["cache", "kvdock", "compression"],
};

const payload100KB = {
  id: 3,
  user: "benchmark-user-bulk",
  data: "x".repeat(100 * 1024),
  tags: ["cache", "kvdock", "bulk"],
};

describe("Compression Codec Benchmarks (Gzip vs Brotli)", () => {
  const gzipCodec = createCompressionCodec({ algorithm: "gzip", threshold: 128 });
  const brotliCodec = createCompressionCodec({ algorithm: "brotli", threshold: 128 });

  const gzip10KBEncoded = gzipCodec.encode(payload10KB);
  const brotli10KBEncoded = brotliCodec.encode(payload10KB);

  bench("Gzip Encode 10KB", () => {
    gzipCodec.encode(payload10KB);
  });

  bench("Gzip Decode 10KB", () => {
    gzipCodec.decode(gzip10KBEncoded);
  });

  bench("Brotli Encode 10KB", () => {
    brotliCodec.encode(payload10KB);
  });

  bench("Brotli Decode 10KB", () => {
    brotliCodec.decode(brotli10KBEncoded);
  });

  const gzip100KBEncoded = gzipCodec.encode(payload100KB);
  const brotli100KBEncoded = brotliCodec.encode(payload100KB);

  bench("Gzip Decode 100KB", () => {
    gzipCodec.decode(gzip100KBEncoded);
  });

  bench("Brotli Decode 100KB", () => {
    brotliCodec.decode(brotli100KBEncoded);
  });
});
