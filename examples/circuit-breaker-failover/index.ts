/**
 * KVDock Example: Circuit Breaker, Active-Passive Failover, and Stale-While-Revalidate (SWR)
 *
 * Demonstrates:
 * 1. Circuit Breaker protection with transparent fallback to in-memory cache during outages.
 * 2. Active-Passive multi-adapter failover with automatic write replication and health recovery.
 * 3. Stale-While-Revalidate (SWR) serving stale cache immediately (0ms wait) with background recomputation.
 */

import { KVDock, withCircuitBreaker, withFailover } from "../../src/index.js";
import { MemoryAdapter } from "../../src/adapters/memory/index.js";
import type { StorageAdapter } from "../../src/core/types.js";

async function main() {
  console.log("🛡️  KVDock High-Availability & Resilience Showcase\n");

  // =========================================================================
  // Part 1: Circuit Breaker with Transparent In-Memory Fallback
  // =========================================================================
  console.log("--- Part 1: Circuit Breaker with Fallback Adapter ---");

  let isRemoteClusterHealthy = true;
  const memoryFallback = new MemoryAdapter();

  // Simulated remote cache adapter that can experience connection outages
  const simulatedRemoteStore = new MemoryAdapter();
  const remoteAdapter: StorageAdapter = {
    name: "remote-cluster",
    capabilities: { ...simulatedRemoteStore.capabilities },
    async get<T>(key: string): Promise<T | null> {
      if (!isRemoteClusterHealthy) {
        throw new Error("Connection reset by remote cluster peer (ECONNRESET)");
      }
      return simulatedRemoteStore.get<T>(key);
    },
    async set<T>(key: string, value: T, opts?: any): Promise<void> {
      if (!isRemoteClusterHealthy) {
        throw new Error("Remote cluster connection timeout (ETIMEDOUT)");
      }
      return simulatedRemoteStore.set(key, value, opts);
    },
    async delete(key: string): Promise<boolean> {
      return simulatedRemoteStore.delete(key);
    },
    async has(key: string): Promise<boolean> {
      return simulatedRemoteStore.has(key);
    },
    async clear(): Promise<void> {
      return simulatedRemoteStore.clear();
    },
    async keys(pattern?: string): Promise<string[]> {
      return simulatedRemoteStore.keys(pattern);
    },
  };

  // Wrap remote adapter with circuit breaker and fallback to local memory
  const resilientAdapter = withCircuitBreaker(remoteAdapter, {
    failureThreshold: 2, // Trips after 2 consecutive errors
    resetTimeoutMs: 1500, // Probes recovery after 1.5s
    fallbackAdapter: memoryFallback,
    onStateChange: (from, to) => {
      console.log(`⚡ [CircuitBreaker] State transition: ${from.toUpperCase()} ➔ ${to.toUpperCase()}`);
    },
    onFallback: (op, key) => {
      console.log(`🔀 [CircuitBreaker] Diverted ${op}('${key ?? ""}') to in-memory fallback`);
    },
  });

  const resilientDock = new KVDock({ adapter: resilientAdapter });

  // 1. Healthy write and read
  console.log("1. Writing session while remote cluster is healthy...");
  await resilientDock.set("session:usr_99", { user: "Sam", tier: "pro" });
  const initialSession = await resilientDock.get("session:usr_99");
  console.log("   ✅ Retrieved:", initialSession);

  // 2. Simulate complete remote cluster outage
  console.log("\n2. Simulating remote cluster network partition / outage...");
  isRemoteClusterHealthy = false;

  // Next operations fail on primary but transparently succeed on fallback!
  await resilientDock.set("session:usr_100", { user: "Elena", tier: "enterprise" });
  const elenaSession = await resilientDock.get("session:usr_100");
  console.log("   ✅ Retrieved via fallback without crash:", elenaSession);

  const snapshot = resilientAdapter.circuitBreaker.getSnapshot();
  console.log(`   📊 Circuit State: ${snapshot.state} (Tripped! Failed: ${snapshot.failedCalls})`);

  // =========================================================================
  // Part 2: Active-Passive Multi-Adapter Failover
  // =========================================================================
  console.log("\n--- Part 2: Multi-Adapter Failover with Write Replication ---");

  const primaryAdapter = new MemoryAdapter();
  const standbyAdapter = new MemoryAdapter();

  const failover = withFailover([primaryAdapter, standbyAdapter], {
    replicateWrites: true, // Standby cache is always warm!
    onFailover: (from, to) => console.log(`🔄 Failover activated: Adapter #${from} ➔ Adapter #${to}`),
    onFailback: (from, to) => console.log(`🔙 Failback restored: Adapter #${from} ➔ Adapter #${to}`),
  });

  const failoverDock = new KVDock({ adapter: failover });

  // Write with replication
  await failoverDock.set("config:flags", { darkMode: true, betaFeatures: true });
  console.log("1. Primary store value:", await primaryAdapter.get("config:flags"));
  console.log("2. Standby replicated value (pre-warmed!):", await standbyAdapter.get("config:flags"));

  // Manually trigger failover
  failover.failover();
  console.log(`3. Active adapter is now: ${failover.stats.activeAdapterName}`);

  // Seamless failback
  failover.failback();
  console.log(`4. Restored active adapter: ${failover.stats.activeAdapterName}`);

  // =========================================================================
  // Part 3: Stale-While-Revalidate (SWR) Zero-Latency Caching
  // =========================================================================
  console.log("\n--- Part 3: Stale-While-Revalidate (SWR) Zero-Latency Serving ---");

  const localDock = new KVDock({ adapter: new MemoryAdapter() });
  let dbFetchCount = 0;

  async function queryProductCatalog() {
    dbFetchCount++;
    await new Promise((r) => setTimeout(r, 80)); // 80ms database query
    return {
      version: dbFetchCount,
      title: "Supercharged Key-Value Engine",
      stock: 142 + dbFetchCount,
    };
  }

  // Initial population
  console.log("1. Populating catalog cache (ttl: 100ms, stale-while-revalidate: 1000ms)...");
  const first = await localDock.getOrSet("catalog:items", queryProductCatalog, {
    ttl: 100,
    staleWhileRevalidate: 1000,
  });
  console.log(`   Initial load took ~80ms. DB fetches: ${dbFetchCount}`, first);

  // Wait 120ms so TTL expires, but entry is within SWR stale window
  await new Promise((r) => setTimeout(r, 120));

  console.log("2. Requesting expired key within SWR window...");
  const swrStart = performance.now();
  const stale = await localDock.getOrSet("catalog:items", queryProductCatalog, {
    ttl: 100,
    staleWhileRevalidate: 1000,
  });
  const swrElapsed = (performance.now() - swrStart).toFixed(2);

  console.log(`   ⚡ Stale value returned in ${swrElapsed}ms (ZERO wait for user!):`, stale);
  console.log(`   📊 Store metrics: staleHits = ${localDock.stats.staleHits}, backgroundRefreshes = ${localDock.stats.backgroundRefreshes}`);

  // Allow background refresh promise to complete
  await new Promise((r) => setTimeout(r, 120));
  const fresh = await localDock.get("catalog:items");
  console.log("3. Subsequent fetch receives refreshed background data:", fresh);

  await resilientDock.close();
  await failoverDock.close();
  await localDock.close();

  console.log("\n✨ All resilience, failover, and SWR demonstrations completed successfully!");
}

main().catch((err) => {
  console.error("Demonstration failed:", err);
  process.exit(1);
});
