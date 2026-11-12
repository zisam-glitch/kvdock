import { describe, expect, it } from "vitest";
import { MemoryAdapter } from "../../adapters/memory/index.js";
import { SchemaValidationError, type StandardSchemaV1, withSchema } from "./index.js";

describe("Type-safe Schema Plugin (withSchema)", () => {
  interface User {
    id: number;
    email: string;
  }

  // Mock standard schema v1
  const userSchema: StandardSchemaV1<unknown, User> = {
    "~standard": {
      version: 1,
      vendor: "custom-test",
      validate: (value: unknown) => {
        const obj = value as Record<string, unknown>;
        if (
          typeof value === "object" &&
          value !== null &&
          "id" in value &&
          typeof obj.id === "number" &&
          "email" in value &&
          typeof obj.email === "string"
        ) {
          return { value: value as User };
        }
        return {
          issues: [{ message: "Expected user object with numeric id and string email" }],
        };
      },
    },
  };

  it("validates and stores valid typed entities", async () => {
    const adapter = new MemoryAdapter();
    const userStore = withSchema(adapter, userSchema);

    await userStore.set("user:1", { id: 1, email: "user@example.com" });
    const user = await userStore.get("user:1");

    expect(user).toEqual({ id: 1, email: "user@example.com" });
  });

  it("rejects invalid entity writes upfront", async () => {
    const adapter = new MemoryAdapter();
    const userStore = withSchema(adapter, userSchema);

    await expect(
      userStore.set("user:2", { id: "not_a_number", email: "fail@example.com" } as unknown as User),
    ).rejects.toThrow(SchemaValidationError);
  });

  it("auto-heals and purges corrupted cache values on read (onInvalid='delete')", async () => {
    const adapter = new MemoryAdapter();
    // Simulate raw corrupted JSON injected into the storage backend
    await adapter.set("user:3", JSON.stringify({ corrupted: true }));

    const userStore = withSchema(adapter, userSchema, { onInvalid: "delete" });

    const result = await userStore.get("user:3");
    expect(result).toBeNull();
    // Verify corrupted key was evicted from storage
    expect(await adapter.has("user:3")).toBe(false);
  });

  it("throws SchemaValidationError when onInvalid='throw'", async () => {
    const adapter = new MemoryAdapter();
    await adapter.set("user:4", JSON.stringify({ corrupted: true }));

    const userStore = withSchema(adapter, userSchema, { onInvalid: "throw" });
    await expect(userStore.get("user:4")).rejects.toThrow(SchemaValidationError);
  });

  it("works with Zod-like safeParse validator objects", async () => {
    const zodLikeValidator = {
      safeParse: (val: unknown) => {
        if (typeof val === "number" && val > 0) {
          return { success: true as const, data: val };
        }
        return { success: false as const, error: new Error("Must be positive number") };
      },
    };

    const adapter = new MemoryAdapter();
    const countStore = withSchema(adapter, zodLikeValidator);

    await countStore.set("visits", 42);
    expect(await countStore.get("visits")).toBe(42);
  });
});
