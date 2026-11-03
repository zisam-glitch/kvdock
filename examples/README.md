# KVDock Examples & Quickstarts

This directory contains executable, end-to-end examples demonstrating KVDock's flagship capabilities across different architectures and frameworks.

## Examples Directory

| Example | Focus Areas | Command |
|---|---|---|
| **[tiered-cache](./tiered-cache/index.ts)** | L1 (Memory) + L2 (SQLite) tiered caching, stampede protection (100 -> 1 request coalescing), automatic promotions | `npx tsx examples/tiered-cache/index.ts` |
| **[distributed-lock](./distributed-lock/index.ts)** | `DistributedMutex` with monotonic fencing tokens, lease renewal, and `DistributedSemaphore` concurrency pooling | `npx tsx examples/distributed-lock/index.ts` |
| **[hono-caching](./hono-caching/index.ts)** | Edge HTTP route caching, automatic ETag generation, conditional `304 Not Modified` revalidation, encrypted sessions | `npx tsx examples/hono-caching/index.ts` |
| **[nextjs-isr](./nextjs-isr/index.ts)** | Next.js 14/15 App Router IncrementalCache handler (`cacheHandler`), tag-based invalidation (`revalidateTag`) | `npx tsx examples/nextjs-isr/index.ts` |

## Running the Examples

All examples are runnable standalone using `tsx`:

```bash
# Tiered cache & stampede coalescing demo
npx tsx examples/tiered-cache/index.ts

# Distributed mutex & semaphore demo
npx tsx examples/distributed-lock/index.ts

# Hono edge route caching & HTTP 304 demo
npx tsx examples/hono-caching/index.ts

# Next.js 14/15 App Router ISR cache handler demo
npx tsx examples/nextjs-isr/index.ts
```
