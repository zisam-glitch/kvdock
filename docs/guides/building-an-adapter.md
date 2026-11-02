# Contributor Guide: Building a Custom Adapter in 15 Minutes

Thank you for contributing to **kvdock**! This guide walks you through building, testing, and submitting a new storage driver from scratch.

---

## Architecture Overview

All `kvdock` adapters implement the strict `StorageAdapter` contract defined in [`src/core/types.ts`](../../src/core/types.ts).

```text
┌────────────────────────────────────────────────────────┐
│                   StorageAdapter                       │
├────────────────────────────────────────────────────────┤
│ + name: string                                         │
│ + capabilities: AdapterCapabilities                    │
│                                                        │
│ + get<T>(key: string): Promise<T | null>               │
│ + set<T>(key: string, value: T, options?): Promise<void>│
│ + delete(key: string): Promise<boolean>                │
│ + has(key: string): Promise<boolean>                   │
│ + clear(): Promise<void>                               │
│ + keys(pattern?: string): Promise<string[]>            │
│                                                        │
│ Optional: getMany, setMany, deleteMany, compareAndSwap │
└────────────────────────────────────────────────────────┘
```

---

## Step 1: Scaffold Your Adapter

We provide an automated generator to bootstrap your adapter directory, tests, and exports in one command:

```bash
npm run create:adapter <your-adapter-name>
```

**Example:**
```bash
npm run create:adapter memcached
```

This will automatically:
1. Create `src/adapters/memcached/index.ts`
2. Create `src/adapters/memcached/index.test.ts`
3. Create `src/adapters/memcached/index.bench.ts`
4. Register the export in `package.json` and `tsup.config.ts`

---

## Step 2: Implement the Adapter Logic

Open `src/adapters/<name>/index.ts` and fill in the CRUD methods.

Key guidelines:
- **Prefix Isolation:** If a prefix is supplied, always namespace keys before sending to storage (`${prefix}${key}`) and strip the prefix when returning from `keys()`.
- **Conditional Writes (`nx` / `xx`):**
  - If `options.nx` is `true`, only write if the key does not exist.
  - If `options.xx` is `true`, only write if the key already exists.
- **TTL Support:** If your storage backend has native TTL, convert millisecond TTL into the target backend format. If expired, `get()` must return `null`.

---

## Step 3: Run the Compliance Test Suite

Instead of writing dozens of repetitive unit tests, import the official test harness in `src/adapters/<name>/index.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { defineAdapterTestSuite } from "../../testing/index.js";
import { MemcachedAdapter } from "./index.js";

// Automatically runs 25+ conformance tests!
defineAdapterTestSuite({
  name: "MemcachedAdapter",
  createAdapter: () => new MemcachedAdapter({ /* options */ }),
  teardown: async (adapter) => {
    await adapter.disconnect?.();
  }
});
```

Run tests locally:

```bash
npm test
```

---

## Step 4: Quality & Formatting Checks

Before opening your pull request, run the unified verification script:

```bash
npm run check
```

This will automatically run TypeScript typechecking (`tsc --noEmit`), Biome linting/formatting (`biome check src`), and Vitest tests.

---

## Step 5: Submit Your Pull Request

1. Create a branch:
   ```bash
   git checkout -b feat/adapter-memcached
   ```
2. Commit with conventional commit syntax:
   ```bash
   git commit -m "feat(adapter): add memcached storage driver"
   ```
3. Push and open a Pull Request referencing the corresponding issue (e.g. `Fixes #8`).
4. Our CI pipeline will run multi-platform tests and verify zero regressions.
5. You will be automatically added to the `README.md` Contributors wall via All-Contributors!
