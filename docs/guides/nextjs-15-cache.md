# Next.js 15 App Router Incremental Cache Handler Guide

This guide demonstrates how to configure **KVDock** as the custom `cacheHandler` for **Next.js 14 and Next.js 15 App Router**. 

Using KVDock eliminates vendor lock-in with proprietary serverless cache providers (such as Vercel KV) while providing **zero-dependency multi-tier caching (L1 Memory + L2 Redis/SQLite)** with built-in cache stampede protection.

---

## 1. Why Use KVDock for Next.js 15?

- **Zero-Dependency Multi-Tiering**: Keep hot ISR routes and fetch calls in ultra-fast Node/Bun memory (L1), backed by Redis, PostgreSQL, or SQLite (L2).
- **Stampede Shield**: Prevents thundering herds when high-traffic ISR pages expire simultaneously under load.
- **Full Tag Revalidation**: Native support for Next.js `revalidateTag()` and `revalidatePath()`.
- **Self-Hosting Ready**: Perfect for Docker, Coolify, Railway, Fly.io, Kubernetes, and bare-metal deployments.

---

## 2. Installation

Install KVDock in your Next.js project:

```bash
npm install kvdock
# If using Redis for persistent L2 caching:
npm install ioredis
```

---

## 3. Configuration

### Step A: Create `cache-handler.mjs`

In the root of your Next.js project (next to `next.config.js`), create `cache-handler.mjs`:

```javascript
import { KVDock, TieredDock } from "kvdock";
import { MemoryAdapter } from "kvdock/adapters/memory";
import { RedisAdapter } from "kvdock/adapters/redis";
import { KVDockNextCacheHandler } from "kvdock/integrations/nextjs";
import Redis from "ioredis";

// 1. Configure ultra-fast L1 In-Memory Cache
const l1Memory = new MemoryAdapter({
  maxSize: 5_000,
});

// 2. Configure distributed L2 Redis Cache (optional for multi-container deployments)
const redisClient = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379", {
  lazyConnect: true,
  maxRetriesPerRequest: 2,
});

const l2Redis = new RedisAdapter({
  client: redisClient,
});

// 3. Combine into a Tiered Dock (L1 Memory with automatic L2 promotion)
const tieredDock = new TieredDock({
  tiers: [l1Memory, l2Redis],
  defaultTTL: 3600_000, // 1 hour default
});

// 4. Configure KVDock Next.js Cache Handler
KVDockNextCacheHandler.configure({
  dock: tieredDock,
  keyPrefix: "nextjs:cache:",
  defaultTTL: 86400, // 24 hours
});

export default KVDockNextCacheHandler;
```

---

### Step B: Configure `next.config.mjs`

Point Next.js to your custom cache handler using the experimental `cacheHandler` option:

```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  // Use custom cache handler for ISR & fetch caching
  experimental: {
    cacheHandler: process.env.NODE_ENV === "production" 
      ? new URL("./cache-handler.mjs", import.meta.url).pathname 
      : undefined,
  },
};

export default nextConfig;
```

---

## 4. Usage in Next.js App Router

### Tag-Based Revalidation
KVDock automatically tracks Next.js cache tags:

```typescript
// app/blog/[slug]/page.tsx
export async function getPost(slug: string) {
  const res = await fetch(`https://api.example.com/posts/${slug}`, {
    next: {
      revalidate: 3600, // 1 hour ISR
      tags: ["posts", `post:${slug}`],
    },
  });
  return res.json();
}
```

When updating content in a Server Action or Route Handler:

```typescript
// app/actions.ts
"use server";

import { revalidateTag } from "next/cache";

export async function updatePost(slug: string) {
  await db.posts.update(...);
  // KVDock immediately invalidates all L1 and L2 cache entries tagged with "posts"
  revalidateTag("posts");
}
```

---

## 5. Verification & Testing

Build and run your Next.js application in production mode:

```bash
npm run build
npm run start
```

Inspect your cache logs or Redis keys to verify entries under `nextjs:cache:*`.
