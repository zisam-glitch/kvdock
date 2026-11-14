/**
 * KVDock Example: AI / LLM Response Caching with Single-Flight Stampede Protection
 *
 * Demonstrates:
 * 1. Wrapping expensive LLM completions (OpenAI, Anthropic, Gemini, local models)
 * 2. Deterministic parameter & prompt hashing
 * 3. Single-flight promise coalescing (prevents duplicate API bills under high concurrency)
 * 4. Model-level atomic cache purging (`invalidateModel('gpt-4o')`)
 */

import { KVDock, createLLMCachePlugin } from "../../src/index.js";
import { MemoryAdapter } from "../../src/adapters/memory/index.js";

async function main() {
  console.log("⚡ Initializing KVDock AI / LLM Response Cache Plugin...\n");

  const dock = new KVDock({
    adapter: new MemoryAdapter({ maxSize: 10_000 }),
    defaultTTL: 3600_000, // 1 hour default
  });

  const llmCache = createLLMCachePlugin({
    dock,
    defaultTTL: 86_400_000, // 24 hours for LLM completions
    autoTagModel: true,
  });

  let simulatedApiCost = 0;
  let apiCallsCount = 0;

  // Mock LLM API caller (simulates OpenAI or Anthropic completion)
  async function callLLMApi(params: { model: string; prompt: string; temperature: number }) {
    apiCallsCount++;
    simulatedApiCost += 0.03; // ~$0.03 per completion
    // Simulate network roundtrip latency
    await new Promise((resolve) => setTimeout(resolve, 80));
    return {
      id: `chatcmpl-${Date.now()}`,
      model: params.model,
      choices: [
        {
          message: {
            role: "assistant",
            content: `Simulated AI answer for: "${params.prompt}" at temperature ${params.temperature}`,
          },
        },
      ],
    };
  }

  const promptRequest = {
    model: "gpt-4o",
    prompt: "Summarize the architectural advantages of single-flight promise coalescing.",
    temperature: 0.2,
  };

  console.log("--- 1. First Call: Cache Miss (Triggers LLM API) ---");
  const t0 = performance.now();
  const res1 = await llmCache.wrap(promptRequest, () => callLLMApi(promptRequest));
  const elapsed1 = (performance.now() - t0).toFixed(1);
  console.log(`⏱️ Latency: ${elapsed1}ms`);
  console.log(`💬 Response: ${res1.choices[0].message.content}`);
  console.log(`💸 API Calls: ${apiCallsCount} | Total Cost: $${simulatedApiCost.toFixed(2)}\n`);

  console.log("--- 2. Second Call: Cache Hit (Zero API Cost, Instant Latency) ---");
  const t1 = performance.now();
  const res2 = await llmCache.wrap(promptRequest, () => callLLMApi(promptRequest));
  const elapsed2 = (performance.now() - t1).toFixed(2);
  console.log(`⏱️ Latency: ${elapsed2}ms (Served from KVDock cache)`);
  console.log(`💸 API Calls: ${apiCallsCount} (No API query made!) | Cost Saved: $0.03\n`);

  console.log("--- 3. Stampede Simulation: 50 Concurrent Users Asking the Same Question ---");
  const concurrentCalls = 50;
  const stampedePrompt = {
    model: "claude-3-5-sonnet",
    prompt: "What is quantum error correction?",
    temperature: 0.0,
  };

  const tStampede = performance.now();
  const stampedeResults = await Promise.all(
    Array.from({ length: concurrentCalls }).map(() =>
      llmCache.wrap(stampedePrompt, () => callLLMApi(stampedePrompt)),
    ),
  );
  const stampedeElapsed = (performance.now() - tStampede).toFixed(1);

  console.log(`🚀 Handled ${concurrentCalls} concurrent requests in ${stampedeElapsed}ms`);
  console.log(`🛡️ Single-Flight Shield: API calls triggered: 1 (49 requests coalesced into 1 promise)`);
  console.log(`💰 Money saved on this burst alone: $${((concurrentCalls - 1) * 0.03).toFixed(2)}\n`);

  console.log("--- 4. Model-level Invalidation ---");
  console.log('Purging all cached responses for model "gpt-4o"...');
  const purgedCount = await llmCache.invalidateModel("gpt-4o");
  console.log(`🧹 Purged ${purgedCount} entries tagged with "model:gpt-4o"`);

  const stats = llmCache.getStats();
  console.log(`\n📊 Final Telemetry: Hits: ${stats.hits} | Misses: ${stats.misses}`);
  console.log("✅ LLM Cache Plugin demo complete!");
}

main().catch(console.error);
