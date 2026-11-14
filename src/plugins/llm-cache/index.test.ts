import { describe, expect, it, vi } from "vitest";
import { MemoryAdapter } from "../../adapters/memory/index.js";
import { KVDock } from "../../core/store.js";
import { LLMCachePlugin, createLLMCachePlugin, defaultHashLLMParams } from "./index.js";

describe("LLMCachePlugin", () => {
  it("generates deterministic hash regardless of key insertion order", () => {
    const hashA = defaultHashLLMParams({
      model: "gpt-4o",
      prompt: "Hello world",
      temperature: 0.7,
    });
    const hashB = defaultHashLLMParams({
      temperature: 0.7,
      prompt: "Hello world",
      model: "gpt-4o",
    });

    expect(hashA).toBe(hashB);
  });

  it("caches responses and prevents duplicate fetcher calls", async () => {
    const dock = new KVDock({ adapter: new MemoryAdapter() });
    const plugin = createLLMCachePlugin({ dock });

    const fetcher = vi.fn().mockResolvedValue({
      id: "cmpl-1",
      choices: [{ text: "Cached response" }],
    });

    const params = { model: "gpt-4o", prompt: "Explain quantum computing" };

    // First call: triggers fetcher
    const res1 = await plugin.wrap(params, fetcher);
    expect(res1.choices[0].text).toBe("Cached response");
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Second call: served from cache
    const res2 = await plugin.wrap(params, fetcher);
    expect(res2.choices[0].text).toBe("Cached response");
    expect(fetcher).toHaveBeenCalledTimes(1);

    const stats = plugin.getStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
  });

  it("coalesces concurrent requests with single-flight stampede protection", async () => {
    const dock = new KVDock({ adapter: new MemoryAdapter() });
    const plugin = new LLMCachePlugin({ dock });

    let callCount = 0;
    const slowFetcher = async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 50));
      return { answer: "42" };
    };

    const params = { model: "claude-3-5-sonnet", prompt: "Meaning of life" };

    // Execute 10 concurrent requests for the same prompt
    const results = await Promise.all([
      plugin.wrap(params, slowFetcher),
      plugin.wrap(params, slowFetcher),
      plugin.wrap(params, slowFetcher),
      plugin.wrap(params, slowFetcher),
      plugin.wrap(params, slowFetcher),
    ]);

    expect(callCount).toBe(1);
    for (const r of results) {
      expect(r.answer).toBe("42");
    }
  });

  it("supports model-level tag invalidation", async () => {
    const dock = new KVDock({ adapter: new MemoryAdapter() });
    const plugin = createLLMCachePlugin({ dock, autoTagModel: true });

    const fetcherGpt = vi.fn().mockResolvedValue({ text: "gpt" });
    const fetcherClaude = vi.fn().mockResolvedValue({ text: "claude" });

    await plugin.wrap({ model: "gpt-4o", prompt: "Test" }, fetcherGpt);
    await plugin.wrap({ model: "claude-3-5-sonnet", prompt: "Test" }, fetcherClaude);

    expect(fetcherGpt).toHaveBeenCalledTimes(1);
    expect(fetcherClaude).toHaveBeenCalledTimes(1);

    // Invalidate all cached responses for gpt-4o
    const purged = await plugin.invalidateModel("gpt-4o");
    expect(purged).toBeGreaterThanOrEqual(1);

    // gpt-4o should miss and re-fetch
    await plugin.wrap({ model: "gpt-4o", prompt: "Test" }, fetcherGpt);
    expect(fetcherGpt).toHaveBeenCalledTimes(2);

    // claude should still hit cache
    await plugin.wrap({ model: "claude-3-5-sonnet", prompt: "Test" }, fetcherClaude);
    expect(fetcherClaude).toHaveBeenCalledTimes(1);
  });

  it("supports explicit get, set, and invalidate", async () => {
    const dock = new KVDock({ adapter: new MemoryAdapter() });
    const plugin = createLLMCachePlugin({ dock });

    const params = { model: "gemini-1.5-pro", prompt: "Hi" };

    expect(await plugin.get(params)).toBeNull();

    await plugin.set(params, { reply: "Hello!" });
    const cached = await plugin.get<{ reply: string }>(params);
    expect(cached?.reply).toBe("Hello!");

    await plugin.invalidate(params);
    expect(await plugin.get(params)).toBeNull();
  });
});
