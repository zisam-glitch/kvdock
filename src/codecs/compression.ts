import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";
import { SerializationError } from "../core/errors.js";
import type { ValueCodec } from "../core/types.js";

export type CompressionAlgorithm = "gzip" | "brotli";

export interface CompressionCodecOptions {
  algorithm?: CompressionAlgorithm;
  threshold?: number; // Minimum payload length in bytes to compress (default: 1024)
}

const GZIP_PREFIX = "\u0000__GZ__:";
const BROTLI_PREFIX = "\u0000__BR__:";

export function createCompressionCodec<T = unknown>(
  options: CompressionCodecOptions = {},
): ValueCodec<T> {
  const algorithm = options.algorithm ?? "gzip";
  const threshold = options.threshold ?? 1024;

  return {
    encode(value: T): string {
      try {
        const json = JSON.stringify(value);
        if (Buffer.byteLength(json, "utf-8") < threshold) {
          return json;
        }

        if (algorithm === "brotli") {
          const compressed = brotliCompressSync(Buffer.from(json, "utf-8"));
          return `${BROTLI_PREFIX}${compressed.toString("base64")}`;
        }

        const compressed = gzipSync(Buffer.from(json, "utf-8"));
        return `${GZIP_PREFIX}${compressed.toString("base64")}`;
      } catch (err) {
        throw new SerializationError("failed to compress payload", err);
      }
    },

    decode(raw: string): T {
      try {
        if (raw.startsWith(GZIP_PREFIX)) {
          const base64 = raw.slice(GZIP_PREFIX.length);
          const decompressed = gunzipSync(Buffer.from(base64, "base64"));
          return JSON.parse(decompressed.toString("utf-8")) as T;
        }

        if (raw.startsWith(BROTLI_PREFIX)) {
          const base64 = raw.slice(BROTLI_PREFIX.length);
          const decompressed = brotliDecompressSync(Buffer.from(base64, "base64"));
          return JSON.parse(decompressed.toString("utf-8")) as T;
        }

        // Uncompressed transparent passthrough
        return JSON.parse(raw) as T;
      } catch (err) {
        throw new SerializationError("failed to decompress payload", err);
      }
    },
  };
}
