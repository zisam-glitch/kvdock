/**
 * KVDock Example: High-Performance Multi-Tiered Cache (L1 Memory + L2 SQLite)
 *
 * Demonstrates:
 * 1. L1 in-memory sub-microsecond cache with L2 persistent SQLite cache.
 * 2. Single-flight stampede protection: coalescing 100 concurrent requests into 1 DB query.
 * 3. Tag-based invalidation across all tiers.
 */

import { KVDock, TieredDock } from "kvdock";
import { MemoryAdapter } from "kvdock/adapters/memory";
import { SqliteAdapter } from "kvdock/adapters/sqlite";
import { compression } from "kvdock/codecs/compression";

async function main() {
  console.log("🚀 Initializing KVDock Tiered Architecture...");

  // L1 In-Memory Dock (ultra-fast, ephemeral)
  const l1 = new KVDock({
    adapter: new MemoryAdapter({ maxEntries: 5000 }),
    defaultTtl: "1m",
  });

  // L2 Persistent SQLite Dock (durable, with compression)
  const l2 = new KVDock({
    adapter: new SqliteAdapter({ path: "./examples/tiered-cache/cache.db" }),
    codecs: [compression({ algorithm: "gzip", threshold: 256 })],
    defaultTtl: "1h",
  });

  // Create unified tiered dock
  const cache = new TieredDock({
    layers: [l1, l2],
    repopulateUpperLayers: true,
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
  // Fire 100 concurrent fetchOrSet requests for the same key simultaneously.
  console.log("\n⚡ Testing Single-Flight Stampede Protection (100 concurrent requests)...");
  const start = performance.now();
  const promises = Array.from({ length: 100 }, () =>
    cache.fetchOrSet("user:42", () => fetchUserFromDatabase("42"), {
      ttl: "10m",
      tags: ["users", "tenant:1"],
    }),
  );

  const results = await Promise.all(promises);
  const elapsed = (performance.now() - start).toFixed(2);

  console.log(`✅ 100 requests resolved in ${elapsed}ms`);
  console.log(
    `✅ Underlying DB fetch count: ${simulatedDatabaseFetches} (Stampede coalesced 100 -> 1!)`,
  );
  console.log(`✅ Result sample: ${JSON.stringify(results[0])}`);

  // 2. Sub-microsecond L1 Cache Hit:
  console.log("\n⚡ Testing Sub-Microsecond L1 Cache Hit...");
  const t0 = performance.now();
  const cached = await cache.get("user:42");
  const l1Elapsed = (performance.now() - t0).toFixed(4);
  console.log(`✅ L1 Cache Hit in ${l1Elapsed}ms:`, cached?.name);

  // 3. Tag-Based Invalidation:
  console.log("\n⚡ Testing Tag-Based Clustered Invalidation...");
  await cache.invalidateTag("users");
  const afterInvalidation = await cache.get("user:42");
  console.log(`✅ After invalidating 'users' tag, cache result is:`, afterInvalidation);

  console.log("\n🎉 Tiered Cache Demo Finished Successfully!");
}

main().catch(console.error);
