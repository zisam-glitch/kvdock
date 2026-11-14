---
title: "Sub-Millisecond Route & Eden Treaty Caching in Bun, Elysia.js, and Hono"
tags: bun, typescript, backend, performance
---

Modern TypeScript runtimes like **Bun** and edge frameworks like **Elysia.js** and **Hono** can handle 100,000+ HTTP requests per second—until your route handler makes a database query or upstream API call that takes 25ms.

Even worse, if you only use a remote Redis or Cloudflare KV store for caching, every cache read still pays a **1–5ms network serialization penalty**—and when a hot key expires under load, concurrent requests trigger a **cache stampede (thundering herd)** against your database.

Here is how we solved both problems in [**KVDock**](https://github.com/zisam-glitch/kvdock) using zero-dependency multi-tier caching (`TieredDock`) and native Elysia/Hono plugins.

> 🎮 **[Test the Interactive Browser Stampede Simulator](https://zisam-glitch.github.io/kvdock/playground/index.html)**  
> ⭐ **Support open-source: [Give KVDock a ★ Star on GitHub](https://github.com/zisam-glitch/kvdock)**

---

## 1. Elysia.js Route & Context Caching in 5 Lines

With `kvdock`, you can attach a sub-0.05ms L1 memory cache (or L1 Memory + L2 SQLite/Redis `TieredDock`) directly to your Elysia server:

```typescript
import { Elysia } from "elysia";
import { KVDock } from "kvdock";
import { MemoryAdapter } from "kvdock/adapters/memory";

const dock = new KVDock({
  adapter: new MemoryAdapter({ maxEntries: 10_000 }),
  ttl: 30_000,
});

const app = new Elysia()
  .get("/leaderboard", async () => {
    // 1,000 concurrent requests during a cache miss -> 1 DB query!
    return await dock.getOrSet("leaderboard:top100", async () => {
      return await db.query("SELECT * FROM scores ORDER BY points DESC LIMIT 100");
    });
  })
  .listen(3000);
```

---

## 2. Hono Edge Middleware with Tag Invalidation

Group related cache entries with tags (`tags: ["products", "featured"]`) and purge them atomically on mutation:

```typescript
import { Hono } from "hono";
import { KVDock } from "kvdock";
import { MemoryAdapter } from "kvdock/adapters/memory";

const app = new Hono();
const dock = new KVDock({ adapter: new MemoryAdapter() });

app.get("/api/products", async (c) => {
  const data = await dock.getOrSet(
    "products:list",
    () => fetchProductsFromDB(),
    { ttl: 60_000, tags: ["products"] }
  );
  return c.json(data);
});

app.post("/api/products", async (c) => {
  await createProductInDB(await c.req.json());
  // Purge all keys tagged with "products" in one call
  await dock.invalidateTag("products");
  return c.json({ ok: true });
});
```

---

## Get Started

```bash
bun add kvdock
# or: npm install kvdock
```

- 📦 **GitHub Repository**: [https://github.com/zisam-glitch/kvdock](https://github.com/zisam-glitch/kvdock)
- 🎮 **Live Stampede Simulator**: [https://zisam-glitch.github.io/kvdock/playground/index.html](https://zisam-glitch.github.io/kvdock/playground/index.html)

If you're building with Bun, Elysia, Hono, or Next.js, **please [drop a ★ Star on GitHub](https://github.com/zisam-glitch/kvdock)** to help us hit our 16-star milestone!
