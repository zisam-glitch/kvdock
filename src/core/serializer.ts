import { SerializationError } from "./errors.js";
import type { Serializer } from "./types.js";

export const defaultSerializer: Serializer = {
  serialize(value: unknown): string {
    try {
      return JSON.stringify(value);
    } catch (err) {
      throw new SerializationError("failed to serialize value to json", err);
    }
  },
  deserialize<T = unknown>(raw: string): T {
    try {
      return JSON.parse(raw) as T;
    } catch (err) {
      throw new SerializationError("failed to parse json payload", err);
    }
  },
};

export const rawSerializer: Serializer = {
  serialize(value: unknown): string {
    return String(value);
  },
  deserialize<T = unknown>(raw: string): T {
    return raw as unknown as T;
  },
};

export function createCodecSerializer<T = unknown>(codec: {
  encode(value: T): string;
  decode(raw: string): T;
}): Serializer {
  return {
    serialize(value: unknown): string {
      try {
        return codec.encode(value as T);
      } catch (err) {
        throw new SerializationError("codec failed to encode payload", err);
      }
    },
    deserialize<R = unknown>(raw: string): R {
      try {
        return codec.decode(raw) as unknown as R;
      } catch (err) {
        throw new SerializationError("codec failed to decode payload", err);
      }
    },
  };
}
