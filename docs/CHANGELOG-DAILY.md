# Daily changelog

One honest line per shipped item.

- **2026-11-03**: Added opt-in real Redis server integration test suite (`src/adapters/redis/integration.test.ts`), fixed prefix handling in `RedisAdapter.clear()`, and added `@types/node` and `ioredis` to devDependencies.
- **2026-11-03**: Added opt-in real PostgreSQL and MongoDB integration test suites (`src/adapters/postgres/integration.test.ts`, `src/adapters/mongodb/integration.test.ts`), declared optional peerDependencies for `pg`, `mongodb`, and `ioredis` in `package.json`.
- **2026-11-03**: Updated `README.md` with honest maturity tiers (Stable, Production Integration, Experimental), detailed peer dependency documentation, and updated `SECURITY.md` supported versions table.
- **2026-11-03**: Added automated `npm pack` tarball smoke test to CI pipeline (`.github/workflows/ci.yml`), verifying fresh isolated installation and package export integrity.
- **2026-11-03**: Published real newcomer issues with `good first issue` and `help wanted` labels (#106, #107, #108) with actionable specs, verified `SECURITY.md` and `CONTRIBUTING.md`.
- **2026-11-03**: Published multi-adapter benchmark results in `docs/PERFORMANCE_MATRIX.md` executed locally with real payload measurements across 1KB, 10KB, and 100KB sizes.
