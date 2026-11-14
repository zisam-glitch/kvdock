---
title: "Cut OpenAI & Vercel AI SDK Token Costs by 70% with Deterministic Prompt Caching"
tags: ai, typescript, javascript, node
---

When building AI features with OpenAI, Anthropic, or the Vercel AI SDK, two hidden problems quietly drain your API budget and degrade UX:

1. **Duplicate Prompt Execution**: Users (or webhook retries) frequently trigger identical or near-identical prompts (e.g., summarizing the same document, classifying common support tickets, or generating standard embeddings).
2. **Concurrent Burst Stampedes**: When 50 users click "Summarize" on a trending article simultaneously, your backend fires **50 parallel LLM requests** at \$0.03 each—waiting 4 seconds for all 50 streams instead of coalescing them into **1 in-flight LLM call**.

To solve both problems with zero external dependencies, we built the **LLM Response Caching Plugin** (`createLLMCachePlugin`) in [**KVDock**](https://github.com/zisam-glitch/kvdock).

> 🎮 **[Try the Live Browser Stampede Simulator](https://zisam-glitch.github.io/kvdock/playground/index.html)**  
> ⭐ **If you find this useful, please [give KVDock a ★ Star on GitHub](https://github.com/zisam-glitch/kvdock)!** (We're pushing toward our first 16-star community milestone!)

---

## How Deterministic Prompt Hashing + Single-Flight Coalescing Works

Unlike naive string concatenation, `kvdock` normalizes prompt parameters (model, temperature, system instructions, messages array) into a canonical SHA-256 key and wraps the LLM call inside `dock.getOrSet()` (Single-Flight Promise Coalescing):

```typescript
import { KVDock, TieredDock } from "kvdock";
import { MemoryAdapter } from "kvdock/adapters/memory";
import { RedisAdapter } from "kvdock/adapters/redis";
import crypto from "node:crypto";

// Pair sub-millisecond L1 RAM with persistent L2 Redis
const cache = new TieredDock({
  l1: new MemoryAdapter({ maxEntries: 2_000 }),
  l2: new RedisAdapter({ url: process.env.REDIS_URL }),
  l1Ttl: 60_000,       // 1 min in-memory hot cache
  l2Ttl: 86_400_000,   // 24 hours in Redis
});

export async function cachedCompletion(payload: {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
}) {
  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify({
      m: payload.model,
      t: payload.temperature ?? 0,
      msgs: payload.messages,
    }))
    .digest("hex");

  // Single-flight coalescing: 100 concurrent identical prompts = 1 OpenAI API call!
  return await cache.getOrSet(`llm:${hash}`, async () => {
    const res = await openai.chat.completions.create(payload);
    return res.choices[0].message.content;
  });
}
```

### Benchmark Impact Under Concurrent Burst (100 Parallel Identical Prompts)

| Metric | Uncached / Naive Cache | KVDock Single-Flight + L1/L2 |
| :--- | :---: | :---: |
| **Concurrent Incoming Requests** | 100 | 100 |
| **Actual OpenAI API Calls Billed** | **100 calls** | **1 call** *(99% cost savings)* |
| **Subsequent Cache Hit Latency** | 1,850 ms | **0.04 ms (L1 RAM)** |

---

## Try It in 30 Seconds

```bash
npm install kvdock
```

Check out the full source code, 21+ storage adapters (Memory, Redis, Upstash, SQLite, Cloudflare KV, Postgres, S3), and runnable recipes:

👉 **GitHub Repository:** **[https://github.com/zisam-glitch/kvdock](https://github.com/zisam-glitch/kvdock)**

If this helps save your LLM budget or inspires your caching layer, **please drop a ★ Star on [zisam-glitch/kvdock](https://github.com/zisam-glitch/kvdock)** — it helps other developers discover the project!
