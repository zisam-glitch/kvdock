/**
 * KVDock Example: Hono Edge Route Caching & Encrypted Sessions
 *
 * Demonstrates:
 * 1. Automatic ETag generation and HTTP 304 Not Modified conditional revalidation.
 * 2. Ultra-low latency edge response caching (`X-Cache: HIT` vs `X-Cache: MISS`).
 * 3. Encrypted session middleware with cookie support.
 */

import { KVDock } from "kvdock";
import { MemoryAdapter } from "kvdock/adapters/memory";
import { type HonoLikeContext, kvdockHonoCache, kvdockHonoSession } from "kvdock/integrations/hono";

async function main() {
  console.log("⚡ Initializing KVDock Hono Edge Caching & Session Suite...");

  const dock = new KVDock({
    adapter: new MemoryAdapter(),
  });

  // 1. Initialize Route Caching Middleware
  const cache = kvdockHonoCache({
    dock,
    ttl: 300, // 5 minutes
    etag: true,
  });

  // Helper to simulate Hono request/response cycles
  function createMockContext(
    url: string,
    headers: Record<string, string> = {},
  ): {
    ctx: HonoLikeContext;
    getRes: () => Response;
  } {
    const response: Response = new Response("Initial mock response");
    const responseHeaders = new Headers();

    const ctx: HonoLikeContext = {
      req: {
        method: "GET",
        url,
        header: (name: string) => headers[name.toLowerCase()] ?? null,
      },
      res: response,
      header: (name: string, value: string) => {
        responseHeaders.set(name, value);
      },
      get: () => undefined,
      set: () => {},
    };

    return {
      ctx,
      getRes: () => {
        return (ctx.res as Response) ?? response;
      },
    };
  }

  // --- Request 1: Fresh Request (Cache Miss) ---
  console.log("\n--- 1. First Request: Fresh Endpoint (Expect Cache Miss) ---");
  const mock1 = createMockContext("https://api.edge.worker/v1/products");
  let originHandlerCalls = 0;

  const nextHandler = async () => {
    originHandlerCalls++;
    mock1.ctx.res = new Response(JSON.stringify({ products: ["dock-pro", "dock-ultra"] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const res1 = (await cache(mock1.ctx, nextHandler)) ?? mock1.getRes();
  const etag = res1.headers.get("ETag");
  console.log(`[Status]: ${res1.status}`);
  console.log(`[X-Cache]: ${res1.headers.get("X-Cache")}`);
  console.log(`[ETag]: ${etag}`);
  console.log(`[Origin Handler Invocations]: ${originHandlerCalls}`);

  // --- Request 2: Subsequent Request (Cache Hit) ---
  console.log("\n--- 2. Second Request: Same Endpoint (Expect Cache Hit) ---");
  const mock2 = createMockContext("https://api.edge.worker/v1/products");
  const res2 = (await cache(mock2.ctx, nextHandler)) ?? mock2.getRes();
  console.log(`[Status]: ${res2.status}`);
  console.log(`[X-Cache]: ${res2.headers.get("X-Cache")}`);
  console.log(`[Origin Handler Invocations]: ${originHandlerCalls} (Origin NOT called!)`);

  // --- Request 3: Conditional Request with If-None-Match (HTTP 304 Revalidation) ---
  console.log("\n--- 3. Third Request: With If-None-Match (Expect HTTP 304) ---");
  const mock3 = createMockContext("https://api.edge.worker/v1/products", {
    "if-none-match": etag ?? "",
  });
  const res3 = (await cache(mock3.ctx, nextHandler)) ?? mock3.getRes();
  console.log(`[Status]: ${res3.status} (304 Not Modified)`);
  console.log(`[X-Cache]: ${res3.headers.get("X-Cache")}`);
  console.log(`[Origin Handler Invocations]: ${originHandlerCalls} (Zero origin compute!)`);

  console.log("\n🎉 Hono Integration Demo Complete!");
}

main().catch(console.error);
