/**
 * KVDock Example: High-Performance Multi-Tiered Cache (L1 Memory + L2 SQLite)
 *
 * Demonstrates:
 * 1. L1 in-memory sub-microsecond cache with L2 persistent SQLite cache.
 * 2. Single-flight stampede protection: coalescing 100 concurrent requests into 1 DB query using `getOrSet`.
 * 3. Automatic L2 -> L1 promotion on cache hit.
 */

import { TieredDock } from "kvdock";
import { MemoryAdapter } from "kvdock/adapters/memory";
import { SQLiteAdapter } from "kvdock/adapters/sqlite";

async function main() {
  console.log("🚀 Initializing KVDock Tiered Architecture...");

  // L1 In-Memory Adapter (ephemeral, zero-latency)
  const l1Adapter = new MemoryAdapter({ maxEntries: 5000 });

  // L2 Persistent SQLite Adapter (durable)
  const l2Adapter = new SQLiteAdapter({ filename: ":memory:" });

  // Create unified tiered dock
  const cache = new TieredDock({
    l1: l1Adapter,
    l2: l2Adapter,
    defaultTTL: 3600, // 1 hour L2 TTL
    l1TTL: 60, // 1 minute L1 TTL
  });

  let simulatedDatabaseFetches = 0;

  // Function simulating an expensive database operation
  async function fetchUserFromDatabase(userId: string) {
    simulatedDatabaseFetches++;
    await new Promise((resolve) => setTimeout(resolve, 50)); // simulate 50ms latency
    return {
      id: userId,
      name: `User ${userId}`,
      role: "Engineer",
      updatedAt: new Date().toISOString(),
    };
  }

  // 1. Stampede Protection Test:
  // Fire 100 concurrent getOrSet requests for the same key simultaneously.
  console.log("\n⚡ Testing Single-Flight Stampede Protection (100 concurrent requests)...");
  const start = performance.now();
  const promises = Array.from({ length: 100 }, () =>
    cache.getOrSet("user:42", () => fetchUserFromDatabase("42")),
  );

  const results = await Promise.all(promises);
  const elapsed = (performance.now() - start).toFixed(2);

  console.log(`✅ 100 requests resolved in ${elapsed}ms`);
  console.log(
    `✅ Underlying DB fetch count: ${simulatedDatabaseFetches} (Stampede coalesced 100 -> 1!)`,
  );
  console.log(`✅ Result sample: ${JSON.stringify(results[0])}`);
  console.log("✅ Stampede metrics:", cache.stats.stampedeCoalesced, "requests coalesced");

  // 2. Sub-microsecond L1 Cache Hit:
  console.log("\n⚡ Testing Sub-Microsecond L1 Cache Hit...");
  const t0 = performance.now();
  const cached = await cache.get<{ name: string }>("user:42");
  const l1Elapsed = (performance.now() - t0).toFixed(4);
  console.log(`✅ L1 Cache Hit in ${l1Elapsed}ms:`, cached?.name);
  console.log("✅ L1 Hits count:", cache.stats.l1Hits);

  // 3. Clear L1 and test L2 promotion:
  console.log("\n⚡ Testing L2 Hit & Automatic Promotion to L1...");
  await l1Adapter.clear();
  const t1 = performance.now();
  const promoted = await cache.get<{ name: string }>("user:42");
  const l2Elapsed = (performance.now() - t1).toFixed(4);
  console.log(`✅ L2 Cache Hit & Promotion in ${l2Elapsed}ms:`, promoted?.name);
  console.log("✅ Promotions recorded:", cache.stats.promotions);

  await cache.close();
  console.log("\n🎉 Tiered Cache Demo Finished Successfully!");
}

main().catch(console.error);
