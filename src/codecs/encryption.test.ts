import { describe, expect, it } from "vitest";
import { MemoryAdapter } from "../adapters/memory/index.js";
import { KVDock } from "../core/store.js";
import { createEncryptionCodec } from "./encryption.js";

describe("Encryption Codec", () => {
  const secretKey = "super-secret-key-32-bytes-test!";

  it("encrypts values at rest with zero plaintext leakage", async () => {
    const memory = new MemoryAdapter();
    const codec = createEncryptionCodec({ secretKey });
    const dock = new KVDock({
      adapter: memory,
      serializer: codec,
    });

    const sensitiveUser = {
      id: 42,
      email: "alice@example.com",
      token: "secret_api_token_12345",
    };

    await dock.set("user:42", sensitiveUser);

    // Verify stored payload in adapter contains zero plaintext
    const rawStored = (await memory.get("user:42")) as string;
    expect(rawStored.startsWith("__kvc_enc::")).toBe(true);
    expect(rawStored.includes("alice@example.com")).toBe(false);
    expect(rawStored.includes("secret_api_token_12345")).toBe(false);

    // Decrypt and verify equality
    const retrieved = await dock.get<typeof sensitiveUser>("user:42");
    expect(retrieved).toEqual(sensitiveUser);
  });

  it("rejects tampered or corrupted ciphertext", async () => {
    const memory = new MemoryAdapter();
    const codec = createEncryptionCodec({ secretKey });
    const dock = new KVDock({
      adapter: memory,
      serializer: codec,
    });

    await dock.set("secure:data", { secret: "confidential" });
    const rawStored = (await memory.get("secure:data")) as string;

    // Tamper with the ciphertext
    const tampered = `${rawStored.slice(0, -4)}AAAA`;
    await memory.set("secure:data", tampered);

    // Deserialization must throw SerializationError due to auth tag verification
    await expect(dock.get("secure:data")).rejects.toThrow(/Failed to decrypt/);
  });

  it("rejects decryption when wrong secret key is provided", async () => {
    const memory = new MemoryAdapter();
    const codec1 = createEncryptionCodec({ secretKey: "key-one-12345678901234567890" });
    const codec2 = createEncryptionCodec({ secretKey: "key-two-different-key-123456" });

    const dock1 = new KVDock({ adapter: memory, serializer: codec1 });
    const dock2 = new KVDock({ adapter: memory, serializer: codec2 });

    await dock1.set("private:key", { value: 100 });

    await expect(dock2.get("private:key")).rejects.toThrow(/Failed to decrypt/);
  });
});
