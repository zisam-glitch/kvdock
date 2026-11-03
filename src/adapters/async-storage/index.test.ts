import { beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncStorageAdapter } from "./index.js";

describe("AsyncStorageAdapter", () => {
  let adapter: AsyncStorageAdapter;

  beforeEach(() => {
    adapter = new AsyncStorageAdapter({ prefix: "@test:" });
  });

  it("sets and gets string values", async () => {
    await adapter.set("user_token", "jwt_abc_123");
    expect(await adapter.get("user_token")).toBe("jwt_abc_123");
    expect(await adapter.has("user_token")).toBe(true);
  });

  it("returns null for nonexistent keys", async () => {
    expect(await adapter.get("nonexistent")).toBeNull();
    expect(await adapter.has("nonexistent")).toBe(false);
  });

  it("handles ttl expiration", async () => {
    vi.useFakeTimers();
    try {
      await adapter.set("session_data", "temp_payload", { ttl: 2000 });
      expect(await adapter.get("session_data")).toBe("temp_payload");

      vi.advanceTimersByTime(2500);
      expect(await adapter.get("session_data")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("deletes keys", async () => {
    await adapter.set("auth_flag", "active");
    expect(await adapter.delete("auth_flag")).toBe(true);
    expect(await adapter.get("auth_flag")).toBeNull();
    expect(await adapter.delete("auth_flag")).toBe(false);
  });

  it("supports atomic compareAndSwap", async () => {
    expect(await adapter.compareAndSwap("cas_rn", null, "v1")).toBe(true);
    expect(await adapter.get("cas_rn")).toBe("v1");

    expect(await adapter.compareAndSwap("cas_rn", "wrong", "v2")).toBe(false);
    expect(await adapter.get("cas_rn")).toBe("v1");

    expect(await adapter.compareAndSwap("cas_rn", "v1", "v2")).toBe(true);
    expect(await adapter.get("cas_rn")).toBe("v2");
  });

  it("filters keys by glob pattern", async () => {
    await adapter.set("pref:theme", "dark");
    await adapter.set("pref:lang", "en");
    await adapter.set("state:cached", "true");

    const prefs = await adapter.keys("pref:*");
    expect(prefs.sort()).toEqual(["pref:lang", "pref:theme"]);
  });

  it("clears only prefixed keys", async () => {
    await adapter.set("k1", "v1");
    await adapter.clear();
    expect(await adapter.get("k1")).toBeNull();
  });

  it("safely handles malformed and non-envelope JSON without throwing", async () => {
    const rawStorage = (
      adapter as unknown as { storage: { setItem: (k: string, v: string) => Promise<void> } }
    ).storage;

    // 1. Broken syntax
    await rawStorage.setItem("@test:corrupted", "{ broken json");
    expect(await adapter.get("corrupted")).toBeNull();
    expect(await adapter.has("corrupted")).toBe(false);

    // 2. Primitive values
    await rawStorage.setItem("@test:num", "98765");
    expect(await adapter.get("num")).toBeNull();

    await rawStorage.setItem("@test:str", '"raw string"');
    expect(await adapter.get("str")).toBeNull();

    await rawStorage.setItem("@test:null_literal", "null");
    expect(await adapter.get("null_literal")).toBeNull();

    // 3. Object missing 'v'
    await rawStorage.setItem("@test:other_obj", JSON.stringify({ note: "no value" }));
    expect(await adapter.get("other_obj")).toBeNull();

    // 4. Listing keys skips malformed entries
    await adapter.set("valid_entry", "valid");
    const keys = await adapter.keys();
    expect(keys).toEqual(["valid_entry"]);
  });
});
