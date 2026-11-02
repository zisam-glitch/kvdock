# Contributing to kvdock

## Quick Start

```bash
git clone https://github.com/zisam-glitch/kvdock.git
cd kvdock
npm install
npm run check
```

## Creating a Storage Adapter (15-Minute Guide)

You can scaffold a compliant adapter in one command:

```bash
npm run create:adapter <name>
# Example: npm run create:adapter memcached
```

This generates `src/adapters/<name>/` with boilerplate code, pre-configured test suite using `defineAdapterTestSuite`, benchmark suite, and updates exports in `package.json` and `tsup.config.ts`.

Read the complete guide: [Building a Custom Adapter in 15 Minutes](docs/guides/building-an-adapter.md).

### Requirements:

1. **Strict Interface Compliance**: Implement `StorageAdapter` from `src/core/types.ts`.
2. **Compliance Test Suite**: Use `defineAdapterTestSuite` from `kvdock/testing` to automatically test 25+ CRUD, TTL, and edge-case contracts.
3. **Zero Core Bloat**: Never add driver-specific packages to the root `dependencies`. Driver SDKs must be `peerDependencies` or dynamically imported.
4. **Co-location**: Code, tests, and benchmarks must live in the same adapter folder.
5. **Coverage**: 95%+ branch coverage for all adapter code.

## Commits & Style

We use conventional commit format:

- `feat(core): add batch get support`
- `feat(adapter): add upstash redis adapter`
- `fix(fs): handle concurrent unlink races`
- `perf(memory): optimize sweep iteration`
- `test(core): add boundary tests for ttl`

Run validation before opening a PR:

```bash
npm run typecheck
npm run lint
npm run test
npm run build
```
