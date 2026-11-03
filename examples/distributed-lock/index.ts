/**
 * KVDock Example: Distributed Mutex & Semaphore with Monotonic Fencing Tokens
 *
 * Demonstrates:
 * 1. Safe distributed mutual exclusion (`DistributedMutex`) across concurrent workers.
 * 2. Monotonic fencing tokens (`handle.fencingToken`) protecting shared resources against out-of-order writes.
 * 3. Concurrent rate-limiting and access pooling via `DistributedSemaphore`.
 */

import { MemoryAdapter } from "kvdock/adapters/memory";
import { DistributedMutex, DistributedSemaphore } from "kvdock/middleware/lock";

async function main() {
  console.log("🔒 Initializing KVDock Distributed Concurrency Engine...");

  const adapter = new MemoryAdapter();

  // 1. Distributed Mutex with Fencing Token
  console.log("\n--- 1. Testing DistributedMutex with Monotonic Fencing Token ---");
  const mutex = new DistributedMutex(adapter, {
    leaseMs: 5000,
    retryIntervalMs: 25,
    maxWaitMs: 3000,
  });

  let sharedResourceLastToken = 0;

  async function simulateWorker(workerId: string) {
    console.log(`[${workerId}] Requesting lock for resource:order-processing...`);
    const handle = await mutex.acquireOrWait("resource:order-processing", { maxWaitMs: 3000 });

    try {
      console.log(`[${workerId}] 🔐 Acquired lock! Fencing Token = ${handle.fencingToken}`);

      // Safety check: fencing token must always monotonically increase
      if (handle.fencingToken <= sharedResourceLastToken) {
        throw new Error(
          `CRITICAL: Stale fencing token detected! Got ${handle.fencingToken}, expected > ${sharedResourceLastToken}`,
        );
      }
      sharedResourceLastToken = handle.fencingToken;

      // Simulate critical section work
      await new Promise((r) => setTimeout(r, 60));
      console.log(`[${workerId}] Finished critical work safely with token ${handle.fencingToken}.`);
    } finally {
      await handle.release();
      console.log(`[${workerId}] 🔓 Released lock.`);
    }
  }

  // Run two workers competing for the same lock
  await Promise.all([simulateWorker("Worker-Alpha"), simulateWorker("Worker-Beta")]);

  // 2. Distributed Semaphore (Rate / Concurrency Limiting)
  console.log("\n--- 2. Testing DistributedSemaphore (Max 2 Concurrent Workers) ---");
  const semaphore = new DistributedSemaphore(adapter, {
    permits: 2,
    leaseMs: 5000,
  });

  let activePermits = 0;
  let maxObservedConcurrencies = 0;

  async function poolClient(clientId: number) {
    const handle = await semaphore.acquireOrWait("pool:heavy-computations", { maxWaitMs: 3000 });
    activePermits++;
    maxObservedConcurrencies = Math.max(maxObservedConcurrencies, activePermits);

    console.log(
      `[Client ${clientId}] Acquired permit slot #${handle.permitSlot}. Active in pool: ${activePermits}`,
    );
    await new Promise((r) => setTimeout(r, 80));

    activePermits--;
    await handle.release();
    console.log(`[Client ${clientId}] Released permit slot #${handle.permitSlot}.`);
  }

  // Launch 5 concurrent clients with only 2 allowed permits
  await Promise.all([1, 2, 3, 4, 5].map(poolClient));

  console.log(
    `\n✅ Semaphore Concurrency Enforcement: Max observed concurrency was ${maxObservedConcurrencies} (Permit limit was 2).`,
  );
  console.log("🎉 Distributed Concurrency Demo Complete!");
}

main().catch(console.error);
