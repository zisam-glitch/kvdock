import { describe, expect, it } from "vitest";
import type { StorageAdapter } from "../core/types.js";

export interface AdapterTestSuiteOptions {
  name: string;
  createAdapter: () => Promise<StorageAdapter> | StorageAdapter;
  teardown?: (adapter: StorageAdapter) => Promise<void> | void;
  supportsTTL?: boolean;
}

export function defineAdapterTestSuite(options: AdapterTestSuiteOptions): void {
  const { name, createAdapter, teardown, supportsTTL = true } = options;

  describe(`Compliance Suite: ${name}`, () => {
    let adapter: StorageAdapter;

    const setup = async () => {
      adapter = await createAdapter();
      await adapter.clear();
      return adapter;
    };

    const cleanup = async () => {
      if (teardown) {
        await teardown(adapter);
      } else if (adapter.disconnect) {
        await adapter.disconnect();
      }
    };

    it("returns null for non-existent key", async () => {
      const a = await setup();
      expect(await a.get("non_existent_key_xyz")).toBeNull();
      await cleanup();
    });

    it("sets and retrieves a primitive string value", async () => {
      const a = await setup();
      await a.set("greeting", "hello world");
      expect(await a.get("greeting")).toBe("hello world");
      await cleanup();
    });

    it("sets and retrieves complex JSON serializable values", async () => {
      const a = await setup();
      const payload = JSON.stringify({ id: 101, tags: ["auth", "admin"], active: true });
      await a.set("user:101", payload);
      expect(await a.get("user:101")).toBe(payload);
      await cleanup();
    });

    it("accurately reports key existence with has()", async () => {
      const a = await setup();
      expect(await a.has("missing_flag")).toBe(false);
      await a.set("missing_flag", "present");
      expect(await a.has("missing_flag")).toBe(true);
      await cleanup();
    });

    it("deletes existing keys and returns boolean confirmation", async () => {
      const a = await setup();
      await a.set("to_delete", "val");
      expect(await a.delete("to_delete")).toBe(true);
      expect(await a.get("to_delete")).toBeNull();
      expect(await a.delete("to_delete")).toBe(false);
      await cleanup();
    });

    it("clears all keys completely", async () => {
      const a = await setup();
      await a.set("k1", "v1");
      await a.set("k2", "v2");
      await a.clear();
      expect(await a.get("k1")).toBeNull();
      expect(await a.get("k2")).toBeNull();
      expect(await a.keys()).toEqual([]);
      await cleanup();
    });

    it("lists all keys and filters by wildcard pattern", async () => {
      const a = await setup();
      await a.set("user:1", "alice");
      await a.set("user:2", "bob");
      await a.set("order:99", "pending");

      const allKeys = await a.keys();
      expect(allKeys.sort()).toEqual(["order:99", "user:1", "user:2"]);

      const userKeys = await a.keys("user:*");
      expect(userKeys.sort()).toEqual(["user:1", "user:2"]);
      await cleanup();
    });

    if (supportsTTL) {
      it("expires keys after specified TTL", async () => {
        const a = await setup();
        await a.set("temp_token", "secret", { ttl: 50 });
        expect(await a.get("temp_token")).toBe("secret");

        await new Promise((r) => setTimeout(r, 70));
        expect(await a.get("temp_token")).toBeNull();
        expect(await a.has("temp_token")).toBe(false);
        await cleanup();
      });
    }

    it("enforces nx (not exists) conditional write semantics", async () => {
      const a = await setup();
      await a.set("unique_lock", "holder_1", { nx: true });
      expect(await a.get("unique_lock")).toBe("holder_1");

      // Attempt write with nx: true on existing key should be ignored
      await a.set("unique_lock", "holder_2", { nx: true });
      expect(await a.get("unique_lock")).toBe("holder_1");
      await cleanup();
    });

    it("enforces xx (must exist) conditional write semantics", async () => {
      const a = await setup();
      // Should not set when key does not exist
      await a.set("update_only", "initial", { xx: true });
      expect(await a.get("update_only")).toBeNull();

      // First create it
      await a.set("update_only", "created");
      // Now xx should succeed
      await a.set("update_only", "updated", { xx: true });
      expect(await a.get("update_only")).toBe("updated");
      await cleanup();
    });

    it("supports batch operations getMany, setMany, deleteMany", async () => {
      const a = await setup();
      if (a.setMany) {
        await a.setMany([
          { key: "batch:1", value: "one" },
          { key: "batch:2", value: "two" },
          { key: "batch:3", value: "three" },
        ]);
        expect(await a.get("batch:1")).toBe("one");
        expect(await a.get("batch:2")).toBe("two");
      }

      if (a.getMany) {
        const results = await a.getMany(["batch:1", "batch:2", "batch:missing"]);
        expect(results.get("batch:1")).toBe("one");
        expect(results.get("batch:2")).toBe("two");
        expect(results.get("batch:missing")).toBeNull();
      }

      if (a.deleteMany) {
        const count = await a.deleteMany(["batch:1", "batch:2", "batch:nonexistent"]);
        expect(count).toBe(2);
        expect(await a.has("batch:1")).toBe(false);
        expect(await a.has("batch:2")).toBe(false);
      }
      await cleanup();
    });

    it("yields keys via AsyncIterable scan() stream", async () => {
      const a = await setup();
      await a.set("scan:a", "1");
      await a.set("scan:b", "2");
      await a.set("other:c", "3");

      if (a.scan) {
        const streamKeys: string[] = [];
        for await (const k of a.scan("scan:*")) {
          streamKeys.push(k);
        }
        expect(streamKeys.sort()).toEqual(["scan:a", "scan:b"]);
      }
      await cleanup();
    });

    it("handles unicode characters and special symbols in keys and values", async () => {
      const a = await setup();
      const specialKey = "🔑:🚀:é/user?name=日本語";
      const specialVal = "✨🎉 Привет мир!";

      await a.set(specialKey, specialVal);
      expect(await a.get(specialKey)).toBe(specialVal);
      expect(await a.has(specialKey)).toBe(true);

      const keys = await a.keys();
      expect(keys).toContain(specialKey);

      await a.delete(specialKey);
      expect(await a.get(specialKey)).toBeNull();
      await cleanup();
    });

    it("handles empty string values safely", async () => {
      const a = await setup();
      await a.set("empty_key", "");
      expect(await a.get("empty_key")).toBe("");
      expect(await a.has("empty_key")).toBe(true);
      await cleanup();
    });

    it("handles large payloads (100KB+)", async () => {
      const a = await setup();
      const largePayload = "X".repeat(1024 * 100);
      await a.set("large_payload_key", largePayload);
      expect(await a.get("large_payload_key")).toBe(largePayload);
      await cleanup();
    });

    it("overwrites existing keys cleanly with new values", async () => {
      const a = await setup();
      await a.set("overwrite_me", "version_1");
      expect(await a.get("overwrite_me")).toBe("version_1");
      await a.set("overwrite_me", "version_2");
      expect(await a.get("overwrite_me")).toBe("version_2");
      await cleanup();
    });

    it("handles concurrent writes to distinct keys without corruption", async () => {
      const a = await setup();
      const tasks = Array.from({ length: 50 }, (_, i) => a.set(`concurrent:${i}`, `val:${i}`));
      await Promise.all(tasks);

      const verify = Array.from({ length: 50 }, async (_, i) => {
        const val = await a.get(`concurrent:${i}`);
        expect(val).toBe(`val:${i}`);
      });
      await Promise.all(verify);
      await cleanup();
    });
  });
}
