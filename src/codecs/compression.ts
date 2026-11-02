import {
  brotliCompressSync,
  brotliDecompressSync,
  deflateSync,
  gunzipSync,
  gzipSync,
  inflateSync,
} from "node:zlib";
import { SerializationError } from "../core/errors.js";
import { defaultSerializer } from "../core/serializer.js";
import type { Serializer } from "../core/types.js";

export type CompressionAlgorithm = "brotli" | "gzip" | "deflate";

export interface CompressionCodecOptions {
  /**
   * Compression algorithm to apply.
   * @default "brotli"
   */
  readonly algorithm?: CompressionAlgorithm;

  /**
   * Minimum payload byte length required before compression is applied.
   * Values smaller than this threshold remain uncompressed to avoid size expansion.
   * @default 1024 (1 KB)
   */
  readonly thresholdBytes?: number;

  /**
   * Underlying serializer used for object serialization before compression.
   * @default defaultSerializer (JSON)
   */
  readonly serializer?: Serializer;
}

const MAGIC_PREFIX_BROTLI = "__kvc_br::";
const MAGIC_PREFIX_GZIP = "__kvc_gz::";
const MAGIC_PREFIX_DEFLATE = "__kvc_df::";
const MAGIC_PREFIX_PLAIN = "__kvc_raw::";

function getMagicPrefix(algo: CompressionAlgorithm): string {
  switch (algo) {
    case "brotli":
      return MAGIC_PREFIX_BROTLI;
    case "gzip":
      return MAGIC_PREFIX_GZIP;
    case "deflate":
      return MAGIC_PREFIX_DEFLATE;
  }
}

/**
 * Creates a transparent compression serializer that automatically compresses values
 * exceeding the specified size threshold.
 */
export function createCompressionCodec(options: CompressionCodecOptions = {}): Serializer {
  const algorithm = options.algorithm ?? "brotli";
  const thresholdBytes = options.thresholdBytes ?? 1024;
  const innerSerializer = options.serializer ?? defaultSerializer;
  const prefix = getMagicPrefix(algorithm);

  return {
    serialize(value: unknown): string {
      const rawString = innerSerializer.serialize(value);
      const buffer = Buffer.from(rawString, "utf8");

      if (buffer.length < thresholdBytes) {
        return `${MAGIC_PREFIX_PLAIN}${rawString}`;
      }

      try {
        let compressed: Buffer;
        switch (algorithm) {
          case "brotli":
            compressed = brotliCompressSync(buffer);
            break;
          case "gzip":
            compressed = gzipSync(buffer);
            break;
          case "deflate":
            compressed = deflateSync(buffer);
            break;
        }

        // Only use compressed if it is actually smaller than the original
        const encoded = compressed.toString("base64");
        if (encoded.length < rawString.length) {
          return `${prefix}${encoded}`;
        }
        return `${MAGIC_PREFIX_PLAIN}${rawString}`;
      } catch (err) {
        throw new SerializationError(`Failed to compress payload using ${algorithm}`, err);
      }
    },

    deserialize<T = unknown>(raw: string): T {
      if (typeof raw !== "string") {
        return innerSerializer.deserialize<T>(raw);
      }

      if (raw.startsWith(MAGIC_PREFIX_PLAIN)) {
        return innerSerializer.deserialize<T>(raw.slice(MAGIC_PREFIX_PLAIN.length));
      }

      try {
        if (raw.startsWith(MAGIC_PREFIX_BROTLI)) {
          const base64 = raw.slice(MAGIC_PREFIX_BROTLI.length);
          const decompressed = brotliDecompressSync(Buffer.from(base64, "base64"));
          return innerSerializer.deserialize<T>(decompressed.toString("utf8"));
        }

        if (raw.startsWith(MAGIC_PREFIX_GZIP)) {
          const base64 = raw.slice(MAGIC_PREFIX_GZIP.length);
          const decompressed = gunzipSync(Buffer.from(base64, "base64"));
          return innerSerializer.deserialize<T>(decompressed.toString("utf8"));
        }

        if (raw.startsWith(MAGIC_PREFIX_DEFLATE)) {
          const base64 = raw.slice(MAGIC_PREFIX_DEFLATE.length);
          const decompressed = inflateSync(Buffer.from(base64, "base64"));
          return innerSerializer.deserialize<T>(decompressed.toString("utf8"));
        }

        // Fallback for legacy un-prefixed records
        return innerSerializer.deserialize<T>(raw);
      } catch (err) {
        throw new SerializationError("Failed to decompress cached payload", err);
      }
    },
  };
}
