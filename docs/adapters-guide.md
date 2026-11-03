# Storage Adapters Guide & Architectural Comparison

This guide details the technical trade-offs, operational characteristics, and runtime compatibility matrix across all `kvdock` storage drivers to help you select the ideal adapter for your production architecture.

---

## 1. Adapter Comparison Matrix

| Adapter | Runtime Environment | Latency (p50) | Latency (p99) | Persistence | Distributed Sync | Memory Footprint | Atomic CAS | Import Path |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| **Memory** | Node, Bun, Deno, Edge, Browser | `< 0.01 ms` | `< 0.05 ms` | Ephemeral | Single-node | Bound by `maxSize` | Yes | `kvdock/adapters/memory` |
| **Filesystem (`fs`)** | Node.js, Bun | `0.1 – 0.5 ms` | `1.5 – 3.0 ms` | Disk / Local | Single-node | Low (OS page cache) | No | `kvdock/adapters/fs` |
| **SQLite** | Node.js (>=22), Bun | `0.02 – 0.1 ms` | `0.2 – 0.8 ms` | Disk / `:memory:` | Single-node | Moderate | Yes (Tx) | `kvdock/adapters/sqlite` |
| **Redis / Valkey** | Node, Bun, Deno, Edge (TCP) | `0.3 – 1.0 ms` | `2.0 – 5.0 ms` | RDB / AOF | Multi-node cluster | Managed externally | Supported | `kvdock/adapters/redis` |
| **Upstash (REST)** | Edge, Serverless, Cloudflare, Node | `10 – 35 ms` | `40 – 80 ms` | Managed Cloud | Global distributed | Zero local footprint | No | `kvdock/adapters/upstash` |
| **Cloudflare KV** | Cloudflare Workers & Pages | `5 – 20 ms` | `30 – 50 ms` | Edge Global | Global Read Replicas | Managed by Cloudflare | No | `kvdock/adapters/cloudflare-kv` |
| **IndexedDB** | Web Browser, PWA, Web Worker | `0.5 – 2.0 ms` | `3.0 – 10 ms` | Browser storage | Single browser client | Sandboxed quota | Yes | `kvdock/adapters/indexeddb` |

---

## 2. Deep Dive: Architectural Profiles

### `MemoryAdapter`
- **Ideal For:** Unit testing, ephemeral caching, single-process microservices, and L1 tier in high-throughput applications.
- **Eviction Strategy:** True $O(1)$ Least Recently Used (LRU) with periodic TTL sweeps.
- **Guarantees:** Zero serialization overhead, zero I/O latency, non-blocking.

```typescript
import { KVDock } from "kvdock";
import { MemoryAdapter } from "kvdock/adapters/memory";

const dock = new KVDock({
  adapter: new MemoryAdapter({
    maxSize: 50_000,          // Maximum number of entries
    cleanupIntervalMs: 30_000 // Background TTL sweep interval
  }),
  defaultTTL: 60_000
});
```

---

### `SQLiteAdapter`
- **Ideal For:** CLI tools, local development environments, desktop apps (Electron / Tauri), and edge containers requiring persistent atomic storage without external database daemons.
- **Engine:** Zero-dependency `node:sqlite` (native in Node >= 22) or pluggable SQLite instance (`better-sqlite3`, `bun:sqlite`).
- **Guarantees:** Full ACID transactional batch operations (`setMany`, `deleteMany`), prepared hot statement caching, automated index on `expires_at`.

```typescript
import { KVDock } from "kvdock";
import { SQLiteAdapter } from "kvdock/adapters/sqlite";

const dock = new KVDock({
  adapter: new SQLiteAdapter({
    path: "./cache.sqlite", // or ":memory:" for ephemeral SQLite
    tableName: "kvdock"
  })
});
```

---

### `FsAdapter`
- **Ideal For:** Build pipelines, monorepo artifact caching, local dev caching without SQL binaries.
- **Safety:** True atomic write using random UUID temporary files and POSIX `rename()`, preventing file truncation on unexpected crashes.
- **Key Hashing:** Automatic `base64url` shard indexing (`ab/abcd123.json`) to prevent filesystem directory inode bottlenecks.

```typescript
import { KVDock } from "kvdock";
import { FsAdapter } from "kvdock/adapters/fs";

const dock = new KVDock({
  adapter: new FsAdapter({ dir: "./.cache" }),
  prefix: "build"
});
```

---

### `RedisAdapter`
- **Ideal For:** Clustered production microservices, distributed horizontally-scaled backends.
- **Features:** Millisecond-precision PX TTLs, native pipeline emulation for batch `getMany` and `setMany`, prefix-aware pattern deletion.

```typescript
import { KVDock } from "kvdock";
import { RedisAdapter } from "kvdock/adapters/redis";
import Redis from "ioredis"; // or standard Redis client

const redis = new Redis(process.env.REDIS_URL);
const dock = new KVDock({
  adapter: new RedisAdapter({ client: redis, prefix: "prod:" }),
  defaultTTL: 300_000
});
```

---

### `UpstashAdapter`
- **Ideal For:** Serverless functions (Vercel Serverless, AWS Lambda) and edge environments where persistent TCP socket pools cause connection exhaustion.
- **Protocol:** High-speed REST over standard HTTP `fetch`.
- **Pipeline:** Automatic batched pipeline execution over `/pipeline` endpoint for multi-key queries.

```typescript
import { KVDock } from "kvdock";
import { UpstashAdapter } from "kvdock/adapters/upstash";

const dock = new KVDock({
  adapter: new UpstashAdapter({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    prefix: "serverless:"
  })
});
```

---

### `CloudflareKVAdapter`
- **Ideal For:** Cloudflare Workers, Cloudflare Pages Functions, and edge edge-compute apps.
- **Special Considerations:** Cloudflare KV enforces a minimum 60-second expiration TTL. KVDock automatically clamps sub-minute TTL values to 60 seconds with graceful warnings rather than throwing Cloudflare 400 Bad Request runtime exceptions.

```typescript
import { KVDock } from "kvdock";
import { CloudflareKVAdapter } from "kvdock/adapters/cloudflare-kv";

export default {
  async fetch(req: Request, env: { MY_KV: KVNamespace }) {
    const dock = new KVDock({
      adapter: new CloudflareKVAdapter({ kv: env.MY_KV, prefix: "worker" })
    });
    const user = await dock.getOrSet("user:profile", () => fetchUserProfile());
    return Response.json(user);
  }
};
```

---

### `IndexedDBAdapter`
- **Ideal For:** Progressive Web Apps (PWAs), offline-first web applications, client-side browser caches.
- **Guarantees:** Zero external bundle dependencies, asynchronous Promises wrapping native `IDBRequest`, isolation by database and object store names.
- **Scanning:** `scan(pattern, { batchSize: 100 })` reads records incrementally with a cursor, filtering expired records and stripping the configured prefix. `batchSize` must be a positive safe integer and defaults to 100 records per transaction. Each transaction finishes before keys are yielded, so consumers can pause or stop without keeping a transaction open.

```typescript
import { KVDock } from "kvdock";
import { IndexedDBAdapter } from "kvdock/adapters/indexeddb";

const dock = new KVDock({
  adapter: new IndexedDBAdapter({ dbName: "app_cache", storeName: "documents" }),
  defaultTTL: 86_400_000 // 24 hours
});
```
