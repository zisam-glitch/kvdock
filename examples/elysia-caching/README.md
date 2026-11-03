# KVDock Example: ElysiaJS & Bun.serve Caching

Demonstrates high-throughput route caching and stampede protection for ElysiaJS and native `Bun.serve()` using KVDock and `BunSQLiteAdapter`.

## Features
- **Zero-Dependency Persistence**: Uses `BunSQLiteAdapter` (`kvdock/adapters/bun-sqlite`) with `bun:sqlite`.
- **Elysia Lifecycle Hooks**: Demonstrates `beforeHandle` (cache lookup, conditional 304) and `afterHandle` (response serialization and storage).
- **Conditional HTTP 304 Revalidation**: Computes weak ETags and honors `If-None-Match` to eliminate payload transfer on revalidation.
- **Single-Flight Coalescing**: Uses `dock.getOrSet()` to coalesce 100 simultaneous requests into 1 execution.

## Run

```bash
npx tsx examples/elysia-caching/index.ts
```
