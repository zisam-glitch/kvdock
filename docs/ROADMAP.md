# kvdock Roadmap (one item shipped per day)

- [x] Replace mock-based tests for Redis with an opt-in integration test against a real Redis (docker compose / REDIS_URL)
- [x] Same for Postgres and MongoDB adapters (opt-in integration tests against real POSTGRES_URL and MONGODB_URI)
- [x] Wire MongoDB/Postgres adapters to real client libraries as optional peer deps and document it
- [ ] README: quickstart, adapter matrix with honest maturity levels (stable / experimental)
- [ ] Publish to npm with provenance; add `npm pack` smoke test in CI
- [ ] Add SECURITY.md, CONTRIBUTING.md, real "good first issue" labels
- [ ] Publish benchmark results in docs/PERFORMANCE_MATRIX.md from a real run
- [ ] Add OpenSSF Scorecard GitHub Action and fix findings
- [ ] Write a launch post (Show HN / dev.to) and respond to real feedback
