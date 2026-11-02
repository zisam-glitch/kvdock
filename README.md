# kvdock

[![CI](https://github.com/zisam-glitch/kvdock/actions/workflows/ci.yml/badge.svg)](https://github.com/zisam-glitch/kvdock/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/zisam-glitch/kvdock/badge)](https://securityscorecards.dev/viewer/?uri=github.com/zisam-glitch/kvdock)
[![npm version](https://img.shields.io/npm/v/kvdock.svg)](https://www.npmjs.com/package/kvdock)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Bundle Size](https://img.shields.io/bundlephobia/minzip/kvdock)](https://bundlephobia.com/package/kvdock)

Universal key-value and caching dock with zero-dependency core engine and pluggable storage adapters.

## Highlights

- **Zero Runtime Dependencies**: Core engine has zero dependencies.
- **Tree-Shakeable Adapters**: Import only the storage drivers your app needs.
- **Zero-Conflict Modular Design**: Every adapter is co-located with its tests and benchmarks.
- **Typed Contracts**: Comprehensive TypeScript interfaces for capabilities, TTL, batches, and transactions.
- **Cross-Runtime**: Works in Node.js (>=18), Bun, Deno, and Edge environments.

## Installation

```bash
npm install kvdock
```

## Quick Start

### In-Memory Storage

```typescript
import { KVDock } from "kvdock";
import { MemoryAdapter } from "kvdock/adapters/memory";

const dock = new KVDock({
  adapter: new MemoryAdapter({ maxSize: 10_000 }),
  prefix: "app",
  defaultTTL: 60_000 // 1 minute
});

await dock.set("session:user_1", { role: "admin" });
const user = await dock.get("session:user_1");

// Cache-aside pattern
const data = await dock.getOrSet("expensive:calc", async () => {
  return await computeExpensiveResult();
}, { ttl: 300_000 });
```

### Filesystem Storage

```typescript
import { KVDock } from "kvdock";
import { FsAdapter } from "kvdock/adapters/fs";

const dock = new KVDock({
  adapter: new FsAdapter({ dir: "./.cache" }),
  prefix: "build"
});

await dock.set("artifact_hash", "9f83ac");
```

## Architecture

```text
┌────────────────────────────────────────────────────────┐
│                      Consumer API                      │
│      dock.get() / dock.set() / dock.getOrSet()         │
└───────────────────────────┬────────────────────────────┘
                            │
┌───────────────────────────▼────────────────────────────┐
│                    KVDock Core Engine                  │
│       - Key namespacing (prefix:)                      │
│       - Serialization / deserialization (JSON, raw)    │
│       - Hit / Miss metrics                             │
│       - Graceful fallback & batch resolution           │
└───────────────────────────┬────────────────────────────┘
                            │ (StorageAdapter Contract)
        ┌───────────────────┼────────────────────┐
        │                   │                    │
┌───────▼────────┐  ┌───────▼────────┐  ┌────────▼───────┐
│ Memory Adapter │  │   Fs Adapter   │  │ Redis / Upstash│
│ (LRU + TTL)    │  │ (Atomic write) │  │   (Community)  │
└────────────────┘  └────────────────┘  └────────────────┘
```

## Adapters Matrix

| Adapter | Status | Capabilities | Import |
| ------- | ------ | ------------ | ------ |
| **Memory** | :white_check_mark: Built-in | TTL, Batch, Scan, LRU | `kvdock/adapters/memory` |
| **Filesystem** | :white_check_mark: Built-in | TTL, Scan, Atomic writes | `kvdock/adapters/fs` |
| **Redis / Valkey** | :hammer_and_wrench: Planned | TTL, Batch, Scan, CAS | `kvdock/adapters/redis` |
| **Upstash (REST)** | :hammer_and_wrench: Planned | TTL, Batch, Scan (Serverless) | `kvdock/adapters/upstash` |
| **Cloudflare KV** | :hammer_and_wrench: Planned | TTL, Scan (Edge Workers) | `kvdock/adapters/cloudflare-kv` |
| **SQLite** | :hammer_and_wrench: Planned | TTL, Batch, Atomic Transactions | `kvdock/adapters/sqlite` |
| **IndexedDB** | :hammer_and_wrench: Planned | TTL, Scan (Browser) | `kvdock/adapters/indexeddb` |

Check the [Milestone Board](https://github.com/zisam-glitch/kvdock/milestones) to claim an adapter.

## Multi-Language Implementations

- **Rust**: [`zisam-glitch/kvdock-rs`](https://github.com/zisam-glitch/kvdock-rs) — Thread-safe, zero-dependency caching layer with monotonic `Instant` TTL.
- **Go**: [`zisam-glitch/kvdock-go`](https://github.com/zisam-glitch/kvdock-go) — Generic key-value cache engine with atomic telemetry.
- **Swift**: [`zisam-glitch/kvdock-swift`](https://github.com/zisam-glitch/kvdock-swift) — Actor-isolated concurrent cache with `ContinuousClock`.
- **Kotlin**: [`zisam-glitch/kvdock-kt`](https://github.com/zisam-glitch/kvdock-kt) — Thread-safe $O(1)$ LRU key-value cache for JVM.

## Contributors

<!-- ALL-CONTRIBUTORS-LIST:START - Do not remove or modify this section -->
<!-- prettier-ignore-start -->
<!-- markdownlint-disable -->
<table>
  <tbody>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/zisam-glitch"><img src="https://avatars.githubusercontent.com/u/190885141?v=4" width="100px;" alt="zisam shaikh"/><br /><sub><b>zisam shaikh</b></sub></a><br /><a href="#infra-zisam-glitch" title="Infrastructure">🚇</a> <a href="#maintenance-zisam-glitch" title="Maintenance">🚧</a> <a href="#code-zisam-glitch" title="Code">💻</a> <a href="#doc-zisam-glitch" title="Documentation">📖</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/Vamsi-2581"><img src="https://avatars.githubusercontent.com/u/101239848?v=4" width="100px;" alt="Vamsi"/><br /><sub><b>Vamsi</b></sub></a><br /><a href="#code-Vamsi-2581" title="Code">💻</a> <a href="#test-Vamsi-2581" title="Tests">⚠️</a></td>
    </tr>
  </tbody>
</table>

<!-- markdownlint-restore -->
<!-- prettier-ignore-end -->

<!-- ALL-CONTRIBUTORS-LIST:END -->

This project follows the [all-contributors](https://github.com/all-contributors/all-contributors) specification. Contributions of any kind welcome!

## License

[MIT](LICENSE) © [zisam shaikh](https://github.com/zisam-glitch)
