# Framework Integration Guide

`kvdock` is runtime-agnostic and integrates into any modern JavaScript / TypeScript framework.

---

## 1. Hono (Edge, Cloudflare Workers, Node, Bun)

Create a lightweight route caching middleware for Hono:

```typescript
import { Hono } from "hono";
import { KVDock } from "kvdock";
import { MemoryAdapter } from "kvdock/adapters/memory";

const app = new Hono();
const cache = new KVDock({
  adapter: new MemoryAdapter({ maxSize: 10_000 }),
  defaultTTL: 30_000 // 30 seconds
});

// Generic cache middleware
function cacheRoute(ttlMs = 30_000) {
  return async (c: any, next: () => Promise<void>) => {
    if (c.req.method !== "GET") return await next();

    const cacheKey = `http:${c.req.url}`;
    const cachedResponse = await cache.get<string>(cacheKey);

    if (cachedResponse) {
      c.header("X-Cache", "HIT");
      return c.html(cachedResponse);
    }

    await next();

    if (c.res.status === 200) {
      const body = await c.res.clone().text();
      await cache.set(cacheKey, body, { ttl: ttlMs });
      c.header("X-Cache", "MISS");
    }
  };
}

app.get("/api/data", cacheRoute(60_000), async (c) => {
  const data = await fetchExpensiveAnalytics();
  return c.json(data);
});

export default app;
```

---

## 2. Express

Route caching with automatic JSON serialization:

```typescript
import express, { Request, Response, NextFunction } from "express";
import { KVDock } from "kvdock";
import { SQLiteAdapter } from "kvdock/adapters/sqlite";

const app = express();
const cache = new KVDock({
  adapter: new SQLiteAdapter({ path: "./cache.sqlite" }),
  defaultTTL: 60_000
});

export function expressCache(ttlMs = 60_000) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET") return next();

    const key = `express:${req.originalUrl}`;
    const hit = await cache.get(key);

    if (hit) {
      res.setHeader("X-Cache", "HIT");
      return res.json(hit);
    }

    const originalJson = res.json.bind(res);
    res.json = (body: any) => {
      if (res.statusCode === 200) {
        cache.set(key, body, { ttl: ttlMs }).catch(console.error);
      }
      res.setHeader("X-Cache", "MISS");
      return originalJson(body);
    };

    next();
  };
}

app.get("/users/:id", expressCache(120_000), async (req, res) => {
  const user = await database.findUser(req.params.id);
  res.json(user);
});
```

---

## 3. Next.js App Router (Server Actions & Route Handlers)

```typescript
import { NextResponse } from "next/server";
import { KVDock } from "kvdock";
import { UpstashAdapter } from "kvdock/adapters/upstash";

const cache = new KVDock({
  adapter: new UpstashAdapter({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  }),
  defaultTTL: 300_000
});

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q") ?? "default";

  const result = await cache.getOrSet(`search:${query}`, async () => {
    return await runExpensiveSearchQuery(query);
  });

  return NextResponse.json(result);
}
```
