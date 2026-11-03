# ElysiaJS & Bun.serve Caching Cookbook

This guide demonstrates how to implement high-throughput route caching, conditional HTTP 304 revalidation, and cache stampede protection in **ElysiaJS** and native **`Bun.serve()`** using `kvdock`.

---

## 1. Why KVDock on Bun?

Bun provides native, ultra-fast SQLite through `bun:sqlite`. KVDock's `BunSQLiteAdapter` (`kvdock/adapters/bun-sqlite`) leverages this built-in capability with **zero external npm dependencies**, giving you:
- Persistent or `:memory:` key-value storage at C-speed.
- Automatic TTL expiration and background sweeps.
- Single-flight promise coalescing to eliminate database thundering herds.
- Full compatibility with ElysiaJS lifecycle hooks (`beforeHandle` / `afterHandle`).

---

## 2. ElysiaJS Route Caching Plugin

Elysia's lifecycle model allows us to intercept incoming requests before route execution (`beforeHandle`) and capture the rendered response before returning (`afterHandle`).

### The Reusable Plugin

```typescript
import crypto from "node:crypto";
import { KVDock } from "kvdock";
import { BunSQLiteAdapter } from "kvdock/adapters/bun-sqlite";

export interface ElysiaCacheOptions {
  dock: KVDock;
  ttl?: number; // TTL in seconds (default: 60)
  etag?: boolean; // Enable ETag and HTTP 304 revalidation
}

interface CachedResponse {
  status: number;
  body: string;
  contentType: string;
  etag: string;
}

export function kvdockElysiaCache(options: ElysiaCacheOptions) {
  const { dock, ttl = 60, etag: enableEtag = true } = options;

  return {
    name: "kvdock-elysia-cache",
    // 1. Intercept request before route execution
    async beforeHandle({ request, set }: { request: Request; set: { headers: Record<string, string>; status?: number } }) {
      if (request.method !== "GET" && request.method !== "HEAD") return;

      const cacheKey = `elysia:route:${request.method}:${request.url}`;
      const cached = await dock.get<CachedResponse>(cacheKey);

      if (cached) {
        const clientEtag = request.headers.get("if-none-match");

        // Conditional HTTP 304 Not Modified
        if (enableEtag && clientEtag && clientEtag === cached.etag) {
          set.status = 304;
          set.headers["X-Cache"] = "HIT-REVALIDATED";
          set.headers["ETag"] = cached.etag;
          return new Response(null, { status: 304, headers: set.headers });
        }

        set.headers["X-Cache"] = "HIT";
        set.headers["Content-Type"] = cached.contentType;
        if (enableEtag) set.headers["ETag"] = cached.etag;

        return new Response(request.method === "HEAD" ? null : cached.body, {
          status: cached.status,
          headers: set.headers,
        });
      }

      set.headers["X-Cache"] = "MISS";
    },

    // 2. Cache successful responses
    async afterHandle({ request, response, set }: { request: Request; response: unknown; set: { headers: Record<string, string>; status?: number } }) {
      if (request.method !== "GET" || set.headers["X-Cache"] === "HIT") {
        return response;
      }

      const cacheKey = `elysia:route:${request.method}:${request.url}`;
      const isJson = typeof response === "object" && response !== null;
      const body = isJson ? JSON.stringify(response) : String(response);
      const contentType = isJson ? "application/json" : "text/plain";

      const computedEtag = `W/"${crypto.createHash("sha1").update(body).digest("hex")}"`;

      if (enableEtag) {
        set.headers["ETag"] = computedEtag;
      }

      const envelope: CachedResponse = {
        status: set.status ?? 200,
        body,
        contentType,
        etag: computedEtag,
      };

      await dock.set(cacheKey, envelope, { ttl: ttl * 1000 });
      return response;
    },
  };
}
```

### Applying to an Elysia App

```typescript
import { Elysia } from "elysia";
import { KVDock } from "kvdock";
import { BunSQLiteAdapter } from "kvdock/adapters/bun-sqlite";
import { kvdockElysiaCache } from "./plugin";

const dock = new KVDock({
  adapter: new BunSQLiteAdapter({ filename: "cache.sqlite" }),
});

const app = new Elysia()
  // Mount global or scoped caching plugin
  .use(kvdockElysiaCache({ dock, ttl: 300, etag: true }))
  .get("/api/v1/metrics", async () => {
    // Heavy compute or database query
    const data = await fetchAggregatedMetrics();
    return { timestamp: Date.now(), data };
  })
  .listen(3000);

console.log(`🦊 Elysia server listening on port ${app.server?.port}`);
```

---

## 3. Native `Bun.serve()` Route Caching

If you are using raw `Bun.serve()` without a framework, you can use `dock.getOrSet()` directly to achieve single-flight coalescing:

```typescript
import { KVDock } from "kvdock";
import { BunSQLiteAdapter } from "kvdock/adapters/bun-sqlite";

const dock = new KVDock({
  adapter: new BunSQLiteAdapter(),
  ttl: "60s",
});

Bun.serve({
  port: 3000,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/api/weather") {
      const city = url.searchParams.get("city") ?? "london";
      const cacheKey = `weather:${city}`;

      // Single-flight coalescing: 500 concurrent callers trigger fetcher exactly ONCE
      const data = await dock.getOrSet(cacheKey, async () => {
        const res = await fetch(`https://api.weather.example/forecast?city=${city}`);
        return await res.json();
      });

      return Response.json(data, {
        headers: { "Cache-Control": "public, max-age=60" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
});
```

---

## 4. Benchmark: In-Memory vs Bun SQLite

Measured on macOS M-series using Bun runtime:

| Method | Operations / sec | Latency |
|---|---|---|
| `MemoryAdapter.get()` | ~950,000 ops/s | < 0.001 ms |
| `BunSQLiteAdapter.get()` | ~300,000 ops/s | < 0.003 ms |
| `BunSQLiteAdapter.set()` | ~180,000 ops/s | < 0.005 ms |

---

## 5. Next Steps

- Check out the runnable standalone example in [`examples/elysia-caching/`](https://github.com/zisam-glitch/kvdock/tree/main/examples/elysia-caching).
- Learn about multi-tier caching in the [Tiered Caching Guide](./tiered-caching.md).
