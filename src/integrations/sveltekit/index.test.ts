import { describe, expect, it, vi } from "vitest";
import { MemoryAdapter } from "../../adapters/memory/index.js";
import {
  type SvelteKitRequestEventLike,
  createKVDockHandle,
  createSvelteKitSessionStore,
} from "./index.js";

function mockEvent(
  url = "https://example.com/api/data",
  method = "GET",
  headers: Record<string, string> = {},
  cookiesMap: Record<string, string> = {},
): {
  event: SvelteKitRequestEventLike;
  cookiesSet: Record<string, { value: string; opts?: unknown }>;
  cookiesDeleted: string[];
} {
  const cookiesSet: Record<string, { value: string; opts?: unknown }> = {};
  const cookiesDeleted: string[] = [];

  const reqHeaders = new Headers(headers);
  const request = new Request(url, { method, headers: reqHeaders });

  const event: SvelteKitRequestEventLike = {
    request,
    url: new URL(url),
    locals: {},
    cookies: {
      get: (name: string) => cookiesMap[name],
      set: (name: string, value: string, opts?: Record<string, unknown>) => {
        cookiesSet[name] = { value, opts };
        cookiesMap[name] = value;
      },
      delete: (name: string) => {
        cookiesDeleted.push(name);
        delete cookiesMap[name];
      },
    },
  };

  return { event, cookiesSet, cookiesDeleted };
}

describe("kvdock/integrations/sveltekit - Handle Cache Hook", () => {
  it("intercepts GET requests, caches response, and returns HIT on subsequent calls", async () => {
    const adapter = new MemoryAdapter();
    const handle = createKVDockHandle({ adapter, ttl: 60 });

    let resolveCount = 0;
    const resolve = vi.fn(async () => {
      resolveCount++;
      return new Response(JSON.stringify({ hello: "world" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const { event: event1 } = mockEvent("https://example.com/api/items");
    const res1 = await handle({ event: event1, resolve });

    expect(resolveCount).toBe(1);
    expect(res1.status).toBe(200);
    expect(res1.headers.get("X-Cache")).toBe("MISS");
    expect(res1.headers.get("ETag")).toBeDefined();
    const body1 = await res1.json();
    expect(body1).toEqual({ hello: "world" });

    // Second call should HIT cache without calling resolve
    const { event: event2 } = mockEvent("https://example.com/api/items");
    const res2 = await handle({ event: event2, resolve });

    expect(resolveCount).toBe(1);
    expect(res2.status).toBe(200);
    expect(res2.headers.get("X-Cache")).toBe("HIT");
    const body2 = await res2.json();
    expect(body2).toEqual({ hello: "world" });
  });

  it("handles ETag conditional revalidation returning 304 Not Modified", async () => {
    const adapter = new MemoryAdapter();
    const handle = createKVDockHandle({ adapter });

    const resolve = vi.fn(async () => {
      return new Response("Cached Page Content", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    });

    // 1. Initial request to populate cache
    const { event: event1 } = mockEvent("https://example.com/page");
    const res1 = await handle({ event: event1, resolve });
    const etag = res1.headers.get("ETag");
    expect(etag).toBeDefined();

    // 2. Conditional request with matching If-None-Match
    const { event: event2 } = mockEvent("https://example.com/page", "GET", {
      "if-none-match": etag ?? "",
    });
    const res2 = await handle({ event: event2, resolve });

    expect(res2.status).toBe(304);
    expect(res2.headers.get("X-Cache")).toBe("HIT-REVALIDATED");
    expect(res2.headers.get("ETag")).toBe(etag);
    const text2 = await res2.text();
    expect(text2).toBe("");

    // 3. Conditional request with mismatched ETag returns 200
    const { event: event3 } = mockEvent("https://example.com/page", "GET", {
      "if-none-match": '"mismatched-etag"',
    });
    const res3 = await handle({ event: event3, resolve });
    expect(res3.status).toBe(200);
    expect(res3.headers.get("X-Cache")).toBe("HIT");
  });

  it("bypasses non-GET / non-HEAD requests", async () => {
    const adapter = new MemoryAdapter();
    const handle = createKVDockHandle({ adapter });

    let resolveCount = 0;
    const resolve = vi.fn(async () => {
      resolveCount++;
      return new Response("mutation done", { status: 201 });
    });

    const { event } = mockEvent("https://example.com/api/post", "POST");
    const res = await handle({ event, resolve });

    expect(resolveCount).toBe(1);
    expect(res.status).toBe(201);
    expect(res.headers.get("X-Cache")).toBeNull();
  });

  it("handles HEAD requests returning empty body with cached headers", async () => {
    const adapter = new MemoryAdapter();
    const handle = createKVDockHandle({ adapter });

    const resolve = vi.fn(async () => {
      return new Response("sample payload", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    });

    const { event: getEvent } = mockEvent("https://example.com/head-test");
    await handle({ event: getEvent, resolve });

    const { event: headEvent } = mockEvent("https://example.com/head-test", "HEAD");
    const headRes = await handle({ event: headEvent, resolve });

    expect(headRes.status).toBe(200);
    expect(headRes.headers.get("X-Cache")).toBe("HIT");
    expect(await headRes.text()).toBe("");
  });

  it("respects shouldCache filter and skip conditions", async () => {
    const adapter = new MemoryAdapter();
    const handle = createKVDockHandle({
      adapter,
      shouldCache: (event) => event.url.pathname.startsWith("/cache/"),
    });

    let resolveCount = 0;
    const resolve = vi.fn(async () => {
      resolveCount++;
      return new Response("content", { status: 200 });
    });

    const { event: uncacheable } = mockEvent("https://example.com/nocache/1");
    await handle({ event: uncacheable, resolve });
    await handle({ event: uncacheable, resolve });
    expect(resolveCount).toBe(2);

    const { event: cacheable } = mockEvent("https://example.com/cache/1");
    await handle({ event: cacheable, resolve });
    await handle({ event: cacheable, resolve });
    expect(resolveCount).toBe(3);
  });

  it("respects Vary header configurations", async () => {
    const adapter = new MemoryAdapter();
    const handle = createKVDockHandle({
      adapter,
      vary: ["accept-language"],
    });

    let resolveCount = 0;
    const resolve = vi.fn(async () => {
      resolveCount++;
      return new Response("content", { status: 200 });
    });

    const { event: enEvent } = mockEvent("https://example.com/vary", "GET", {
      "accept-language": "en",
    });
    await handle({ event: enEvent, resolve });
    expect(resolveCount).toBe(1);

    const { event: frEvent } = mockEvent("https://example.com/vary", "GET", {
      "accept-language": "fr",
    });
    await handle({ event: frEvent, resolve });
    expect(resolveCount).toBe(2);

    // Call en again -> cache HIT
    await handle({ event: enEvent, resolve });
    expect(resolveCount).toBe(2);
  });

  it("recovers gracefully from corrupted cache envelopes", async () => {
    const adapter = new MemoryAdapter();
    await adapter.set("sveltekit:cache:GET:/corrupt", "{invalid json");

    const handle = createKVDockHandle({ adapter });
    const resolve = vi.fn(async () => new Response("fallback", { status: 200 }));

    const { event } = mockEvent("https://example.com/corrupt");
    const res = await handle({ event, resolve });

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(await res.text()).toBe("fallback");
  });
});

describe("kvdock/integrations/sveltekit - Session Store", () => {
  it("creates a new session and writes cookie when no cookie exists", async () => {
    const adapter = new MemoryAdapter();
    const sessionStore = createSvelteKitSessionStore({ adapter });

    const { event, cookiesSet } = mockEvent("https://example.com/dashboard");
    const session = await sessionStore.handle(event);

    expect(session.isNew).toBe(true);
    expect(session.sessionId).toBeDefined();
    expect(cookiesSet.kvdock_session).toBeDefined();

    session.data.userId = "usr_123";
    await session.save();

    // Verify persisted in adapter
    const persisted = await sessionStore.getSession(session.sessionId);
    expect(persisted).toEqual({ userId: "usr_123" });
  });

  it("retrieves existing session data from cookie", async () => {
    const adapter = new MemoryAdapter();
    const sessionStore = createSvelteKitSessionStore({ adapter });

    const existingId = "existing-sess-456";
    await sessionStore.setSession(existingId, { role: "admin" });

    const { event } = mockEvent(
      "https://example.com/admin",
      "GET",
      {},
      {
        kvdock_session: existingId,
      },
    );

    const session = await sessionStore.handle(event);
    expect(session.isNew).toBe(false);
    expect(session.sessionId).toBe(existingId);
    expect(session.data).toEqual({ role: "admin" });
  });

  it("destroys session and deletes cookie on destroy()", async () => {
    const adapter = new MemoryAdapter();
    const sessionStore = createSvelteKitSessionStore({ adapter });

    const existingId = "sess-to-destroy";
    await sessionStore.setSession(existingId, { temp: true });

    const { event, cookiesDeleted } = mockEvent(
      "https://example.com/logout",
      "GET",
      {},
      {
        kvdock_session: existingId,
      },
    );

    const session = await sessionStore.handle(event);
    await session.destroy();

    expect(await sessionStore.getSession(existingId)).toBeNull();
    expect(cookiesDeleted).toContain("kvdock_session");
  });

  it("touches session TTL without mutating data", async () => {
    const adapter = new MemoryAdapter();
    const sessionStore = createSvelteKitSessionStore({ adapter });

    await sessionStore.setSession("sess-touch", { counter: 1 }, 10);
    await sessionStore.touchSession("sess-touch", 3600);

    const data = await sessionStore.getSession("sess-touch");
    expect(data).toEqual({ counter: 1 });
  });
});
