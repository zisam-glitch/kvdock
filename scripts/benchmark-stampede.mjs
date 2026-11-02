import { KVDock } from "../dist/index.js";
import { MemoryAdapter } from "../dist/adapters/memory/index.js";

async function runBenchmark() {
  console.log("===============================================================");
  console.log("       KVDock Single-Flight Stampede Protection Benchmark      ");
  console.log("===============================================================\n");

  const CONCURRENT_REQUESTS = 1000;
  const DB_SIMULATED_LATENCY_MS = 25;

  // 1. Traditional Uncoalesced Pattern (Thundering Herd)
  console.log(`[1] Simulating Traditional Caching with ${CONCURRENT_REQUESTS} concurrent requests...`);
  let uncoalescedDbHits = 0;
  const naiveStore = new Map();

  async function naiveDbFetcher() {
    uncoalescedDbHits++;
    await new Promise((r) => setTimeout(r, DB_SIMULATED_LATENCY_MS));
    return { id: "item_42", name: "Enterprise Product Data", timestamp: Date.now() };
  }

  const startNaive = performance.now();
  await Promise.all(
    Array.from({ length: CONCURRENT_REQUESTS }, async () => {
      let val = naiveStore.get("item_42");
      if (!val) {
        val = await naiveDbFetcher();
        naiveStore.set("item_42", val);
      }
      return val;
    })
  );
  const endNaive = performance.now();
  const naiveDuration = endNaive - startNaive;

  console.log(`  - Total Requests:      ${CONCURRENT_REQUESTS}`);
  console.log(`  - Database Invocations: ${uncoalescedDbHits} (THUNDERING HERD DETECTED!)`);
  console.log(`  - Total Time Elapsed:  ${naiveDuration.toFixed(2)} ms`);
  console.log(`  - DB Load Factor:      ${((uncoalescedDbHits / CONCURRENT_REQUESTS) * 100).toFixed(1)}%\n`);

  // 2. KVDock Single-Flight Coalescing
  console.log(`[2] Simulating KVDock getOrSet() with ${CONCURRENT_REQUESTS} concurrent requests...`);
  let kvdockDbHits = 0;
  const dock = new KVDock({
    adapter: new MemoryAdapter({ maxSize: 1000 }),
    defaultTTL: 60000,
  });

  async function kvdockDbFetcher() {
    kvdockDbHits++;
    await new Promise((r) => setTimeout(r, DB_SIMULATED_LATENCY_MS));
    return { id: "item_42", name: "Enterprise Product Data", timestamp: Date.now() };
  }

  const startKVDock = performance.now();
  await Promise.all(
    Array.from({ length: CONCURRENT_REQUESTS }, () =>
      dock.getOrSet("item_42", kvdockDbFetcher)
    )
  );
  const endKVDock = performance.now();
  const kvdockDuration = endKVDock - startKVDock;
  const metrics = dock.stats;

  console.log(`  - Total Requests:      ${CONCURRENT_REQUESTS}`);
  console.log(`  - Database Invocations: ${kvdockDbHits} (100% Stampede Protected)`);
  console.log(`  - Coalesced Requests:  ${metrics.stampedeCoalesced}`);
  console.log(`  - Total Time Elapsed:  ${kvdockDuration.toFixed(2)} ms`);
  console.log(`  - DB Load Reduction:   ${(((uncoalescedDbHits - kvdockDbHits) / uncoalescedDbHits) * 100).toFixed(2)}%\n`);

  console.log("---------------------------------------------------------------");
  console.log(`RESULT: KVDock eliminated ${(uncoalescedDbHits - kvdockDbHits)} redundant backend calls.`);
  console.log(`Throughput speedup: ${(naiveDuration / kvdockDuration).toFixed(2)}x faster completion under stampede.`);
  console.log("===============================================================");
}

runBenchmark().catch(console.error);
