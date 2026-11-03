/**
 * KVDock Example: Distributed Mutex & Semaphore with Monotonic Fencing Tokens
 *
 * Demonstrates:
 * 1. Safe distributed mutual exclusion (`DistributedMutex`) across concurrent workers.
 * 2. Monotonic fencing tokens (`lock.fencingToken`) protecting shared resources against out-of-order writes.
 * 3. Concurrent rate-limiting and access pooling via `DistributedSemaphore`.
 */

import { KVDock } from "kvdock";
import { MemoryAdapter } from "kvdock/adapters/memory";
import { DistributedMutex, DistributedSemaphore } from "kvdock/middleware/lock";

async function main() {
  console.log("🔒 Initializing KVDock Distributed Concurrency Engine...");

  const dock = new KVDock({
    adapter: new MemoryAdapter(),
  });

  // 1. Distributed Mutex with Fencing Token
  console.log("\n--- 1. Testing DistributedMutex with Monotonic Fencing Token ---");
  const mutex = new DistributedMutex(dock, "resource:order-processing", {
    ttlMs: 5000,
    heartbeatIntervalMs: 1000,
  });

  let sharedResourceLastToken = 0;

  async function simulateWorker(workerId: string) {
    console.log(`[${workerId}] Requesting lock...`);
    const acquired = await mutex.acquire({ waitTimeoutMs: 3000, retryIntervalMs: 50 });

    if (!acquired) {
      console.log(`[${workerId}] Failed to acquire lock (timed out).`);
      return;
    }

    try {
      console.log(`[${workerId}] 🔐 Acquired lock! Fencing Token = ${mutex.fencingToken}`);

      // Safety check: fencing token must always monotonically increase
      if (mutex.fencingToken <= sharedResourceLastToken) {
        throw new Error(
          `CRITICAL: Stale fencing token detected! Got ${mutex.fencingToken}, expected > ${sharedResourceLastToken}`,
        );
      }
      sharedResourceLastToken = mutex.fencingToken;

      // Simulate critical section work
      await new Promise((r) => setTimeout(r, 100));
      console.log(`[${workerId}] Finished critical work safely with token ${mutex.fencingToken}.`);
    } finally {
      await mutex.release();
      console.log(`[${workerId}] 🔓 Released lock.`);
    }
  }

  // Run two workers competing for the same lock
  await Promise.all([simulateWorker("Worker-Alpha"), simulateWorker("Worker-Beta")]);

  // 2. Distributed Semaphore (Rate / Concurrency Limiting)
  console.log("\n--- 2. Testing DistributedSemaphore (Max 2 Concurrent Workers) ---");
  const semaphore = new DistributedSemaphore(dock, "pool:heavy-computations", {
    permits: 2,
    ttlMs: 5000,
  });

  let activePermits = 0;
  let maxObservedConcurrencies = 0;

  async function poolClient(clientId: number) {
    const permit = await semaphore.acquire({ waitTimeoutMs: 3000 });
    activePermits++;
    maxObservedConcurrencies = Math.max(maxObservedConcurrencies, activePermits);

    console.log(
      `[Client ${clientId}] Acquired permit #${permit.slot}. Active in pool: ${activePermits}`,
    );
    await new Promise((r) => setTimeout(r, 80));

    activePermits--;
    await semaphore.release(permit);
    console.log(`[Client ${clientId}] Released permit #${permit.slot}.`);
  }

  // Launch 5 concurrent clients with only 2 allowed permits
  await Promise.all([1, 2, 3, 4, 5].map(poolClient));

  console.log(
    `\n✅ Semaphore Concurrency Enforcement: Max observed concurrency was ${maxObservedConcurrencies} (Permit limit was 2).`,
  );
  console.log("🎉 Distributed Concurrency Demo Complete!");
}

main().catch(console.error);
