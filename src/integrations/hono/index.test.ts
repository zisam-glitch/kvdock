import { beforeEach, describe, expect, it } from "vitest";
import { MemoryAdapter } from "../../adapters/memory/index.js";
import { type HonoLikeContext, kvdockHonoCache } from "./index.js";

function createMockContext(
  method: string,
  url: string,
  headers: Record<string, string> = {},
): HonoLikeContext {
  const reqHeaders = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const outHeaders = new Headers();

  const c: HonoLikeContext = {
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
      outHeaders.set(name, value);
    },
    status: (code: number) => {
      c.res = new Response(c.res.body, { status: code, headers: c.res.headers });
    },
  };
  return c;
}

describe("kvdockHonoCache", () => {
  let adapter: MemoryAdapter;

  beforeEach(() => {
    adapter = new MemoryAdapter();
  });

  it("caches GET response on first invocation and serves cache on second", async () => {
    const middleware = kvdockHonoCache({ adapter, ttl: 60 });
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
    expect(res1).toBeUndefined(); // next() was executed
    expect(handlerCalls).toBe(1);

    // Second call (HIT)
    const c2 = createMockContext("GET", "https://api.example.com/data");
    const res2 = await middleware(c2, async () => runHandler(c2));
    expect(res2).toBeInstanceOf(Response);
    expect(res2?.headers.get("X-Cache")).toBe("HIT");
    expect(await res2?.text()).toBe(JSON.stringify({ hello: "world" }));
    expect(handlerCalls).toBe(1); // handler was not called again
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
    const middleware = kvdockHonoCache({ adapter });
    let postHandled = false;

    const c = createMockContext("POST", "https://api.example.com/items");
    await middleware(c, async () => {
      postHandled = true;
    });

    expect(postHandled).toBe(true);
    expect(await adapter.keys()).toEqual([]);
  });
});
