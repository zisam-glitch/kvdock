import { beforeEach, describe, expect, it } from "vitest";
import { MemoryAdapter } from "../../adapters/memory/index.js";
import {
  type HonoLikeContext,
  type SessionStore,
  cacheMiddleware,
  kvdockHonoCache,
  kvdockHonoSession,
  sessionMiddleware,
} from "./index.js";

function createMockContext(
  method: string,
  url: string,
  headers: Record<string, string> = {},
): HonoLikeContext & { outHeaders: Map<string, string>; store: Map<string, unknown> } {
  const reqHeaders = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const outHeaders = new Map<string, string>();
  const store = new Map<string, unknown>();

  const c: HonoLikeContext & { outHeaders: Map<string, string>; store: Map<string, unknown> } = {
    req: {
      method,
      url,
      header: (name: string) => reqHeaders.get(name.toLowerCase()),
    },
    res: new Response("initial body", {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    header: (name: string, value: string) => {
      outHeaders.set(name.toLowerCase(), value);
    },
    status: (code: number) => {
      c.res = new Response(c.res.body, { status: code, headers: c.res.headers });
    },
    set: (key: string, value: unknown) => {
      store.set(key, value);
    },
    get: (key: string) => store.get(key),
    outHeaders,
    store,
  };
  return c;
}

describe("Hono Cache Middleware", () => {
  let adapter: MemoryAdapter;

  beforeEach(() => {
    adapter = new MemoryAdapter();
  });

  it("caches GET response on first invocation and serves cache on second", async () => {
    const middleware = cacheMiddleware({ dock: adapter, ttl: 60 });
    let handlerCalls = 0;

    const runHandler = async (c: HonoLikeContext) => {
      handlerCalls++;
      c.res = new Response(JSON.stringify({ hello: "world" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    // First call (MISS)
    const c1 = createMockContext("GET", "https://api.example.com/data");
    const res1 = await middleware(c1, async () => runHandler(c1));
    expect(res1).toBeUndefined();
    expect(handlerCalls).toBe(1);

    // Second call (HIT)
    const c2 = createMockContext("GET", "https://api.example.com/data");
    const res2 = await middleware(c2, async () => runHandler(c2));
    expect(res2).toBeInstanceOf(Response);
    expect(res2?.headers.get("X-Cache")).toBe("HIT");
    expect(await res2?.text()).toBe(JSON.stringify({ hello: "world" }));
    expect(handlerCalls).toBe(1);
  });

  it("returns 304 Not Modified when If-None-Match matches ETag", async () => {
    const middleware = kvdockHonoCache({ adapter, ttl: 60, etag: true });

    const c1 = createMockContext("GET", "https://api.example.com/items");
    c1.res = new Response("item data", { status: 200 });
    await middleware(c1, async () => {});

    // Inspect cached ETag
    const c2 = createMockContext("GET", "https://api.example.com/items");
    const hitRes = (await middleware(c2, async () => {})) as Response;
    const etag = hitRes.headers.get("ETag");
    expect(etag).toBeTruthy();

    // Send conditional request
    const c3 = createMockContext("GET", "https://api.example.com/items", {
      "if-none-match": etag ?? "",
    });
    const revalRes = (await middleware(c3, async () => {})) as Response;
    expect(revalRes.status).toBe(304);
    expect(revalRes.headers.get("X-Cache")).toBe("HIT-REVALIDATED");
  });

  it("bypasses non-GET and non-HEAD requests", async () => {
    const middleware = cacheMiddleware({ dock: adapter });
    let postHandled = false;

    const c = createMockContext("POST", "https://api.example.com/items");
    await middleware(c, async () => {
      postHandled = true;
    });

    expect(postHandled).toBe(true);
    expect(await adapter.keys()).toEqual([]);
  });

  it("throws error if neither dock nor adapter is provided", () => {
    expect(() => kvdockHonoCache({} as never)).toThrow();
  });
});

describe("Hono Session Middleware", () => {
  let adapter: MemoryAdapter;

  beforeEach(() => {
    adapter = new MemoryAdapter();
  });

  it("creates a new session and attaches Set-Cookie header", async () => {
    const middleware = sessionMiddleware({ dock: adapter, cookieName: "my_sid", ttl: 3600 });
    const c = createMockContext("GET", "https://api.example.com/profile");

    await middleware(c, async () => {
      const session = c.get?.("session") as SessionStore;
      expect(session).toBeDefined();
      expect(session.id).toBeTruthy();
      session.set("user", { name: "Alice", role: "admin" });
    });

    const setCookie = c.outHeaders.get("set-cookie");
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain("my_sid=");
    expect(setCookie).toContain("HttpOnly");

    // Verify stored session in adapter
    const session = c.get?.("session") as SessionStore;
    const raw = await adapter.get<string>(`hono:session:${session.id}`);
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw ?? "{}");
    expect(parsed.user).toEqual({ name: "Alice", role: "admin" });
  });

  it("resumes an existing session from cookie header", async () => {
    const middleware = kvdockHonoSession({ adapter, cookieName: "my_sid" });
    const existingId = "sess-12345";
    await adapter.set(`hono:session:${existingId}`, JSON.stringify({ userId: 42 }));

    const c = createMockContext("GET", "https://api.example.com/profile", {
      cookie: `my_sid=${existingId}`,
    });

    await middleware(c, async () => {
      const session = c.get?.("session") as SessionStore;
      expect(session.id).toBe(existingId);
      expect(session.get("userId")).toBe(42);
      session.set("cartCount", 3);
    });

    // Verify modification was persisted
    const raw = await adapter.get<string>(`hono:session:${existingId}`);
    const parsed = JSON.parse(raw ?? "{}");
    expect(parsed.userId).toBe(42);
    expect(parsed.cartCount).toBe(3);
  });

  it("destroys a session and clears the cookie", async () => {
    const middleware = sessionMiddleware({ adapter, cookieName: "my_sid" });
    const existingId = "sess-destroy";
    await adapter.set(`hono:session:${existingId}`, JSON.stringify({ secret: "data" }));

    const c = createMockContext("POST", "https://api.example.com/logout", {
      cookie: `my_sid=${existingId}`,
    });

    await middleware(c, async () => {
      const session = c.get?.("session") as SessionStore;
      await session.destroy();
    });

    // Check adapter key deleted
    expect(await adapter.has(`hono:session:${existingId}`)).toBe(false);

    // Check Max-Age=0 cookie
    const setCookie = c.outHeaders.get("set-cookie");
    expect(setCookie).toContain("Max-Age=0");
  });

  it("regenerates session id", async () => {
    const middleware = sessionMiddleware({ adapter, cookieName: "my_sid" });
    const existingId = "old-sess-id";
    await adapter.set(`hono:session:${existingId}`, JSON.stringify({ loggedIn: true }));

    const c = createMockContext("POST", "https://api.example.com/login", {
      cookie: `my_sid=${existingId}`,
    });

    let newSessionId = "";
    await middleware(c, async () => {
      const session = c.get?.("session") as SessionStore;
      await session.regenerate();
      newSessionId = session.id;
      session.set("loggedIn", true);
    });

    expect(newSessionId).not.toBe(existingId);
    expect(await adapter.has(`hono:session:${existingId}`)).toBe(false);
    expect(await adapter.has(`hono:session:${newSessionId}`)).toBe(true);
  });
});
