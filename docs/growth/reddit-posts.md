# Reddit Launch Posts for kvdock

These drafts are tailored to the culture and rules of each subreddit. Avoid sounding spammy; focus on engineering insights, benchmarks, and architectural decisions.

---

## 1. r/typescript & r/javascript

**Title:**
> Show & Feedback: I built kvdock – a zero-dependency caching & KV engine with single-flight stampede protection and multi-tier L1/L2 storage

**Post Body:**
```markdown
Hey everyone!

Over the past few months, I built **kvdock**, a TypeScript-first key-value and caching engine designed to solve a few frustrations I've run into repeatedly in production Node/edge apps:

1. **The Cache Stampede (Thundering Herd) problem**: When a popular cache key expires and 1,000 concurrent requests hit it at once, traditional caches send 1,000 parallel queries to the database. `kvdock.getOrSet()` implements single-flight promise coalescing—so all 1,000 incoming callers await a single fetch execution, reducing database spikes by 99.9%.
2. **Multi-Tier Caching out-of-the-box (`TieredDock`)**: Pair an ultra-fast in-memory L1 cache with persistent L2 storage (Redis, SQLite, FileSystem, etc.) with automatic promotion and fallback.
3. **Zero Runtime Dependencies**: The core engine has zero external dependencies, is fully tree-shakeable, and runs across Node (>=18), Bun, Deno, Cloudflare Workers, and modern browsers.
4. **Streaming Scans**: Full `dock.scan()` memory-efficient `AsyncIterable` stream to traverse millions of keys without buffer exhaustion.

### Benchmark (Single-Flight Stampede Coalescing)

| Metric | Traditional Uncoalesced | `kvdock.getOrSet()` | Net Impact |
| :--- | :---: | :---: | :---: |
| **Incoming Concurrent Requests** | 1,000 | 1,000 | Identical load |
| **Primary Database Hits** | 1,000 queries | **1 query** | **99.9% reduction** |
| **Coalesced Callers** | 0 | 999 | Zero lock contention |

We also built an interactive web playground with a live stampede simulator:
🎮 **Playground:** https://zisam-glitch.github.io/kvdock/playground/index.html

📦 **GitHub:** https://github.com/zisam-glitch/kvdock

I'd love feedback on the API ergonomics, the adapter layer, or any edge cases you spot! If you find it interesting or useful, a star on GitHub would mean a lot!
```

---

## 2. r/nextjs

**Title:**
> Open Source: Custom Next.js 15 Incremental Cache Handler with built-in Single-Flight Stampede Protection

**Post Body:**
```markdown
Hi all!

If you've been working with Next.js 15 and wanted more control over the App Router's Incremental Cache without vendor lock-in or huge database spikes during ISR regeneration, I open-sourced **kvdock**:

GitHub: https://github.com/zisam-glitch/kvdock

### Why this exists for Next.js:
- **Next.js 15 Cache Handler**: Implements Next's incremental cache interface natively.
- **Thundering Herd Shield**: When multiple requests hit an expired ISR page simultaneously, `kvdock` coalesces the generation requests so your origin API/DB only gets hit once.
- **Pluggable backends**: Swap seamlessly between Redis, in-memory, SQLite, or multi-tier (L1 RAM + L2 Redis).

Setup is literally 3 lines in `next.config.js`:
```js
module.exports = {
  cacheHandler: require.resolve('kvdock/next'),
};
```

Check out the interactive playground simulator: https://zisam-glitch.github.io/kvdock/playground/index.html

Feedback, PRs, and stars are super appreciated!
```
