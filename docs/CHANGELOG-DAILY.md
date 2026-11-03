# Daily changelog

One honest line per shipped item.

- **2026-11-03**: Added opt-in real Redis server integration test suite (`src/adapters/redis/integration.test.ts`), fixed prefix handling in `RedisAdapter.clear()`, and added `@types/node` and `ioredis` to devDependencies.
- **2026-11-03**: Added opt-in real PostgreSQL and MongoDB integration test suites (`src/adapters/postgres/integration.test.ts`, `src/adapters/mongodb/integration.test.ts`), declared optional peerDependencies for `pg`, `mongodb`, and `ioredis` in `package.json`.
- **2026-11-03**: Updated `README.md` with honest maturity tiers (Stable, Production Integration, Experimental), detailed peer dependency documentation, and updated `SECURITY.md` supported versions table.
