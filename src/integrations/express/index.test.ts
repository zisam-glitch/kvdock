import { beforeEach, describe, expect, it } from "vitest";
import { MemoryAdapter } from "../../adapters/memory/index.js";
import { KVDockExpressStore, type SessionData } from "./index.js";

describe("KVDockExpressStore", () => {
  let adapter: MemoryAdapter;
  let store: KVDockExpressStore;

  beforeEach(() => {
    adapter = new MemoryAdapter();
    store = new KVDockExpressStore({ adapter, prefix: "sess:" });
  });

  it("sets and retrieves a session", async () => {
    const session: SessionData = {
      cookie: { maxAge: 3600000 },
      userId: "u_123",
      role: "admin",
    };

    await new Promise<void>((resolve, reject) => {
      store.set("sid_1", session, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    const loaded = await new Promise<SessionData | null>((resolve, reject) => {
      store.get("sid_1", (err, s) => {
        if (err) reject(err);
        else resolve(s ?? null);
      });
    });

    expect(loaded).toEqual(session);
  });

  it("returns null for nonexistent session", async () => {
    const loaded = await new Promise<SessionData | null>((resolve, reject) => {
      store.get("missing_sid", (err, s) => {
        if (err) reject(err);
        else resolve(s ?? null);
      });
    });

    expect(loaded).toBeNull();
  });

  it("destroys a session", async () => {
    const session: SessionData = { userId: "u_456" };
    await new Promise<void>((resolve, reject) => {
      store.set("sid_2", session, (err) => (err ? reject(err) : resolve()));
    });

    await new Promise<void>((resolve, reject) => {
      store.destroy("sid_2", (err) => (err ? reject(err) : resolve()));
    });

    const loaded = await new Promise<SessionData | null>((resolve, reject) => {
      store.get("sid_2", (err, s) => (err ? reject(err) : resolve(s ?? null)));
    });

    expect(loaded).toBeNull();
  });

  it("retrieves all sessions and length", async () => {
    await new Promise<void>((r) => store.set("s1", { user: "1" }, () => r()));
    await new Promise<void>((r) => store.set("s2", { user: "2" }, () => r()));

    const count = await new Promise<number>((resolve, reject) => {
      store.length((err, len) => (err ? reject(err) : resolve(len ?? 0)));
    });
    expect(count).toBe(2);

    const all = await new Promise<Record<string, SessionData>>((resolve, reject) => {
      store.all((err, map) => (err ? reject(err) : resolve(map ?? {})));
    });
    expect(Object.keys(all).sort()).toEqual(["s1", "s2"]);
    expect(all.s1.user).toBe("1");
    expect(all.s2.user).toBe("2");
  });

  it("clears all sessions", async () => {
    await new Promise<void>((r) => store.set("s1", { user: "1" }, () => r()));
    await new Promise<void>((r) => store.set("s2", { user: "2" }, () => r()));

    await new Promise<void>((resolve, reject) => {
      store.clear((err) => (err ? reject(err) : resolve()));
    });

    const count = await new Promise<number>((resolve, reject) => {
      store.length((err, len) => (err ? reject(err) : resolve(len ?? 0)));
    });
    expect(count).toBe(0);
  });
});
