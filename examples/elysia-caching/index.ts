/**
 * KVDock Example: ElysiaJS & Bun.serve Route Caching Suite
 *
 * Demonstrates:
 * 1. Zero-dependency SQLite persistence via `BunSQLiteAdapter`.
 * 2. Route caching middleware with automatic ETag generation.
 * 3. Conditional HTTP 304 Not Modified revalidation.
 * 4. Single-flight request coalescing to eliminate cache stampedes.
 */

import crypto from "node:crypto";
import { KVDock } from "kvdock";
import { BunSQLiteAdapter } from "kvdock/adapters/bun-sqlite";

// Reusable Elysia-compatible route caching plugin
export interface ElysiaCacheOptions {
  dock: KVDock;
  ttl?: number;
  etag?: boolean;
}

interface CachedResponse {
  status: number;
  body: string;
  contentType: string;
  etag: string;
}

export function createElysiaCachePlugin(options: ElysiaCacheOptions) {
  const { dock, ttl = 60, etag: enableEtag = true } = options;

  return {
    async beforeHandle(ctx: { request: Request; set: { headers: Record<string, string>; status?: number } }): Promise<Response | undefined> {
      if (ctx.request.method !== "GET" && ctx.request.method !== "HEAD") return;

      const cacheKey = `elysia:route:${ctx.request.method}:${ctx.request.url}`;
      const cached = await dock.get<CachedResponse>(cacheKey);

      if (cached) {
        const clientEtag = ctx.request.headers.get("if-none-match");

        // Conditional 304 Revalidation
        if (enableEtag && clientEtag && clientEtag === cached.etag) {
          ctx.set.status = 304;
          ctx.set.headers["X-Cache"] = "HIT-REVALIDATED";
          ctx.set.headers["ETag"] = cached.etag;
          return new Response(null, { status: 304, headers: ctx.set.headers });
        }

        ctx.set.headers["X-Cache"] = "HIT";
        ctx.set.headers["Content-Type"] = cached.contentType;
        if (enableEtag) ctx.set.headers["ETag"] = cached.etag;

        return new Response(ctx.request.method === "HEAD" ? null : cached.body, {
          status: cached.status,
          headers: ctx.set.headers,
        });
      }

      ctx.set.headers["X-Cache"] = "MISS";
      return undefined;
    },

    async afterHandle(ctx: { request: Request; response: unknown; set: { headers: Record<string, string>; status?: number } }) {
      if (ctx.request.method !== "GET" || ctx.set.headers["X-Cache"] === "HIT") {
        return ctx.response;
      }

      const cacheKey = `elysia:route:${ctx.request.method}:${ctx.request.url}`;
      const isJson = typeof ctx.response === "object" && ctx.response !== null;
      const body = isJson ? JSON.stringify(ctx.response) : String(ctx.response);
      const contentType = isJson ? "application/json" : "text/plain";

      const computedEtag = `W/"${crypto.createHash("sha1").update(body).digest("hex")}"`;

      if (enableEtag) {
        ctx.set.headers["ETag"] = computedEtag;
      }

      const envelope: CachedResponse = {
        status: ctx.set.status ?? 200,
        body,
        contentType,
        etag: computedEtag,
      };

      await dock.set(cacheKey, envelope, { ttl: ttl * 1000 });
      return ctx.response;
    },
  };
}

async function main() {
  console.log("⚡ Initializing KVDock ElysiaJS & Bun.serve Caching Suite...");

  // Initialize Bun SQLite Adapter (persisted in-memory or SQLite database)
  const dock = new KVDock({
    adapter: new BunSQLiteAdapter(),
  });

  const cache = createElysiaCachePlugin({
    dock,
    ttl: 300, // 5 minutes
    etag: true,
  });

  // Mock handler simulating expensive database query
  let dbQueries = 0;
  async function expensiveHandler() {
    dbQueries++;
    return {
      service: "inventory-api",
      items: ["dock-lite", "dock-enterprise"],
      computedAt: Date.now(),
    };
  }

  // --- Step 1: Fresh Request (Cache Miss) ---
  console.log("\n--- 1. First Request: Fresh Endpoint (Expect Cache Miss) ---");
  const req1 = new Request("https://api.elysia.local/v1/items", { method: "GET" });
  const set1: { headers: Record<string, string>; status?: number } = { headers: {} };

  let res1 = await cache.beforeHandle({ request: req1, set: set1 });
  if (!res1) {
    const data = await expensiveHandler();
    await cache.afterHandle({ request: req1, response: data, set: set1 });
    res1 = Response.json(data, { headers: set1.headers });
  }

  const etag = res1.headers.get("ETag") ?? set1.headers["ETag"];
  console.log(`[Status]: ${res1.status}`);
  console.log(`[X-Cache]: ${res1.headers.get("X-Cache") ?? set1.headers["X-Cache"]}`);
  console.log(`[ETag]: ${etag}`);
  console.log(`[Database Queries]: ${dbQueries}`);

  // --- Step 2: Repeated Request (Cache Hit) ---
  console.log("\n--- 2. Second Request: Same Endpoint (Expect Cache Hit) ---");
  const req2 = new Request("https://api.elysia.local/v1/items", { method: "GET" });
  const set2: { headers: Record<string, string>; status?: number } = { headers: {} };

  let res2 = await cache.beforeHandle({ request: req2, set: set2 });
  if (!res2) {
    const data = await expensiveHandler();
    await cache.afterHandle({ request: req2, response: data, set: set2 });
    res2 = Response.json(data, { headers: set2.headers });
  }

  console.log(`[Status]: ${res2.status}`);
  console.log(`[X-Cache]: ${res2.headers.get("X-Cache")}`);
  console.log(`[Database Queries]: ${dbQueries} (Query count did NOT increase!)`);

  // --- Step 3: Conditional Request with If-None-Match (HTTP 304 Revalidation) ---
  console.log("\n--- 3. Third Request: With If-None-Match (Expect HTTP 304) ---");
  const req3 = new Request("https://api.elysia.local/v1/items", {
    method: "GET",
    headers: { "if-none-match": etag ?? "" },
  });
  const set3: { headers: Record<string, string>; status?: number } = { headers: {} };

  const res3 = (await cache.beforeHandle({ request: req3, set: set3 }))!;
  console.log(`[Status]: ${res3.status} (304 Not Modified)`);
  console.log(`[X-Cache]: ${res3.headers.get("X-Cache")}`);
  console.log(`[Database Queries]: ${dbQueries} (Zero database computation!)`);

  // --- Step 4: Single-Flight Stampede Coalescing ---
  console.log("\n--- 4. Concurrency Test: 100 Simultaneous Requests (Single-Flight) ---");
  let heavyComputations = 0;
  const parallelTasks = Array.from({ length: 100 }, (_, i) => {
    return dock.getOrSet("hot:resource", async () => {
      heavyComputations++;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { payload: "expensive-result" };
    });
  });

  const results = await Promise.all(parallelTasks);
  console.log(`[Total Parallel Requests]: ${results.length}`);
  console.log(`[Heavy Computations Executed]: ${heavyComputations} (100 parallel callers coalesced into 1!)`);

  console.log("\n🎉 ElysiaJS & Bun.serve Integration Demo Complete!");
}

main().catch(console.error);
