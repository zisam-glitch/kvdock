import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { SerializationError } from "../core/errors.js";
import { defaultSerializer } from "../core/serializer.js";
import type { Serializer } from "../core/types.js";

export interface EncryptionCodecOptions {
  /**
   * Secret key used for AES-256-GCM encryption.
   * Can be a 32-byte Buffer, 64-character hex string, or any passphrase (which will be derived via SHA-256).
   */
  readonly secretKey: string | Buffer;

  /**
   * Underlying serializer used for object serialization prior to encryption.
   * @default defaultSerializer (JSON)
   */
  readonly serializer?: Serializer;
}

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96 bits for GCM
const AUTH_TAG_LENGTH = 16; // 128 bits
const MAGIC_PREFIX_ENC = "__kvc_enc::";

function normalizeKey(secretKey: string | Buffer): Buffer {
  if (Buffer.isBuffer(secretKey)) {
    if (secretKey.length === 32) return secretKey;
    return createHash("sha256").update(secretKey).digest();
  }
  if (typeof secretKey === "string") {
    if (secretKey.length === 64 && /^[0-9a-fA-F]+$/.test(secretKey)) {
      return Buffer.from(secretKey, "hex");
    }
    return createHash("sha256").update(secretKey, "utf8").digest();
  }
  throw new SerializationError("Invalid secret key: must be string or Buffer");
}

/**
 * Creates an authenticated encryption serializer using AES-256-GCM.
 * Values are encrypted with randomized initialization vectors and authenticated tags,
 * ensuring complete confidentiality and tamper detection at rest.
 */
export function createEncryptionCodec(options: EncryptionCodecOptions): Serializer {
  if (!options?.secretKey) {
    throw new SerializationError("secretKey is required to create an encryption codec");
  }

  const key = normalizeKey(options.secretKey);
  const innerSerializer = options.serializer ?? defaultSerializer;

  return {
    serialize(value: unknown): string {
      try {
        const rawString = innerSerializer.serialize(value);
        const iv = randomBytes(IV_LENGTH);
        const cipher = createCipheriv(ALGORITHM, key, iv);

        const encrypted = Buffer.concat([cipher.update(rawString, "utf8"), cipher.final()]);
        const authTag = cipher.getAuthTag();

        // Concatenate IV (12B) + AuthTag (16B) + Ciphertext
        const payload = Buffer.concat([iv, authTag, encrypted]);
        return `${MAGIC_PREFIX_ENC}${payload.toString("base64url")}`;
      } catch (err) {
        throw new SerializationError("Failed to encrypt cached payload", err);
      }
    },

    deserialize<T = unknown>(raw: string): T {
      if (typeof raw !== "string" || !raw.startsWith(MAGIC_PREFIX_ENC)) {
        throw new SerializationError("Payload is not encrypted with KVDock encryption codec");
      }

      try {
        const encoded = raw.slice(MAGIC_PREFIX_ENC.length);
        const buffer = Buffer.from(encoded, "base64url");

        if (buffer.length < IV_LENGTH + AUTH_TAG_LENGTH) {
          throw new SerializationError("Encrypted payload truncated or corrupted");
        }

        const iv = buffer.subarray(0, IV_LENGTH);
        const authTag = buffer.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
        const ciphertext = buffer.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

        const decipher = createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);

        const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

        return innerSerializer.deserialize<T>(decrypted.toString("utf8"));
      } catch (err) {
        throw new SerializationError(
          "Failed to decrypt cached payload: invalid key or tampered data",
          err,
        );
      }
    },
  };
}
