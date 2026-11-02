import { describe, expect, it } from "vitest";
import { SerializationError } from "./errors.js";
import { defaultSerializer, rawSerializer } from "./serializer.js";

describe("Serializers", () => {
  describe("defaultSerializer (JSON)", () => {
    it("serializes and deserializes primitives and objects", () => {
      const obj = { str: "hello", num: 42, flag: true, list: [1, 2, 3] };
      const serialized = defaultSerializer.serialize(obj);
      expect(typeof serialized).toBe("string");
      const deserialized = defaultSerializer.deserialize(serialized);
      expect(deserialized).toEqual(obj);
    });

    it("throws SerializationError on circular references", () => {
      const circular: Record<string, unknown> = { name: "loop" };
      circular.self = circular;

      expect(() => defaultSerializer.serialize(circular)).toThrow(SerializationError);
      try {
        defaultSerializer.serialize(circular);
      } catch (err: unknown) {
        const error = err as SerializationError;
        expect(error.code).toBe("ERR_SERIALIZATION");
        expect(error.cause).toBeInstanceOf(TypeError);
      }
    });

    it("throws SerializationError on malformed JSON payload", () => {
      const malformed = "{ this is not valid json }";

      expect(() => defaultSerializer.deserialize(malformed)).toThrow(SerializationError);
      try {
        defaultSerializer.deserialize(malformed);
      } catch (err: unknown) {
        const error = err as SerializationError;
        expect(error.code).toBe("ERR_SERIALIZATION");
        expect(error.cause).toBeInstanceOf(SyntaxError);
      }
    });
  });

  describe("rawSerializer", () => {
    it("converts values to strings and returns raw payload", () => {
      expect(rawSerializer.serialize(123)).toBe("123");
      expect(rawSerializer.serialize("plain-text")).toBe("plain-text");
      expect(rawSerializer.deserialize("plain-text")).toBe("plain-text");
    });
  });
});
