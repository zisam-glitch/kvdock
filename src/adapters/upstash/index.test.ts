import { describe, expect, it, vi } from "vitest";
import { UpstashAdapter } from "./index.js";

describe("UpstashAdapter", () => {
  it("validates required configuration", () => {
    expect(() => new UpstashAdapter({ url: "", token: "" })).toThrow();
  });

  it("performs get, set, delete, and has with mocked fetch", async () => {
    const memory = new Map<string, string>();

    const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Array<string | number>;
      const op = String(body[0]).toUpperCase();

      if (op === "SET") {
        const key = String(body[1]);
        const val = String(body[2]);
        memory.set(key, val);
        return {
          ok: true,
          status: 200,
          json: async () => ({ result: "OK" }),
        };
      }

      if (op === "GET") {
        const key = String(body[1]);
        return {
          ok: true,
          status: 200,
          json: async () => ({ result: memory.has(key) ? memory.get(key) : null }),
        };
      }

      if (op === "EXISTS") {
        const key = String(body[1]);
        return {
          ok: true,
          status: 200,
          json: async () => ({ result: memory.has(key) ? 1 : 0 }),
        };
      }

      if (op === "DEL") {
        let count = 0;
        for (let i = 1; i < body.length; i++) {
          if (memory.delete(String(body[i]))) count++;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ result: count }),
        };
      }

      if (op === "KEYS") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ result: Array.from(memory.keys()) }),
        };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({ result: null }),
      };
    });

    const adapter = new UpstashAdapter({
      url: "https://example-test.upstash.io",
      token: "secret-token",
      fetch: mockFetch as unknown as typeof fetch,
      prefix: "app:",
    });

    await adapter.set("user", { name: "Alice", role: "admin" });
    expect(await adapter.has("user")).toBe(true);

    const retrieved = await adapter.get<{ name: string; role: string }>("user");
    expect(retrieved).toEqual({ name: "Alice", role: "admin" });

    const keys = await adapter.keys();
    expect(keys).toContain("user");

    const deleted = await adapter.delete("user");
    expect(deleted).toBe(true);
    expect(await adapter.has("user")).toBe(false);
  });

  it("handles batch pipeline operations", async () => {
    const memory = new Map<string, string>();

    const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.endsWith("/pipeline")) {
        const commands = JSON.parse(init?.body as string) as Array<Array<string | number>>;
        const results = commands.map((cmd) => {
          const op = String(cmd[0]).toUpperCase();
          if (op === "SET") {
            memory.set(String(cmd[1]), String(cmd[2]));
            return { result: "OK" };
          }
          if (op === "GET") {
            const key = String(cmd[1]);
            return { result: memory.has(key) ? memory.get(key) : null };
          }
          return { result: null };
        });
        return {
          ok: true,
          status: 200,
          json: async () => results,
        };
      }

      const body = JSON.parse(init?.body as string) as Array<string | number>;
      if (body[0] === "DEL") {
        let count = 0;
        for (let i = 1; i < body.length; i++) {
          if (memory.delete(String(body[i]))) count++;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ result: count }),
        };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({ result: null }),
      };
    });

    const adapter = new UpstashAdapter({
      url: "https://example-test.upstash.io",
      token: "mock-token",
      fetch: mockFetch as unknown as typeof fetch,
    });

    await adapter.setMany([
      { key: "a", value: 100 },
      { key: "b", value: 200 },
    ]);

    const batch = await adapter.getMany(["a", "b", "missing"]);
    expect(batch.get("a")).toBe(100);
    expect(batch.get("b")).toBe(200);
    expect(batch.get("missing")).toBeNull();

    const delCount = await adapter.deleteMany(["a", "b"]);
    expect(delCount).toBe(2);
  });
});
