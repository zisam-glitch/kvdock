import type { KVDock } from "../core/store.js";
import type { StorageAdapter } from "../core/types.js";

export type MigrationEndpoint = StorageAdapter | KVDock;

export interface MigrationProgress {
  total: number;
  copied: number;
  skipped: number;
  failed: number;
  currentKey?: string;
}

export interface MigrationOptions {
  source: MigrationEndpoint;
  target: MigrationEndpoint;
  batchSize?: number;
  concurrency?: number;
  pattern?: string;
  preserveTTL?: boolean;
  overwrite?: boolean;
  retries?: number;
  retryDelayMs?: number;
  transformKey?: (key: string) => string | null | undefined;
  transformValue?: (value: unknown, key: string) => unknown;
  onProgress?: (progress: MigrationProgress) => void;
}

export interface MigrationStats {
  total: number;
  copied: number;
  skipped: number;
  failed: number;
  durationMs: number;
  errors: Array<{ key: string; error: string }>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getAllKeys(endpoint: MigrationEndpoint, pattern?: string): Promise<string[]> {
  if ("scan" in endpoint && typeof endpoint.scan === "function") {
    try {
      const scannedKeys: string[] = [];
      const iterator = endpoint.scan(pattern);
      for await (const key of iterator) {
        scannedKeys.push(key);
      }
      return scannedKeys;
    } catch {
      // Fall through to keys()
    }
  }

  if ("keys" in endpoint && typeof endpoint.keys === "function") {
    return await endpoint.keys(pattern);
  }

  throw new Error("Source endpoint does not support keys() or scan() listing.");
}

async function getRemainingTTL(
  endpoint: MigrationEndpoint,
  key: string,
): Promise<number | undefined> {
  if ("ttl" in endpoint && typeof endpoint.ttl === "function") {
    try {
      const ttlSec = await endpoint.ttl(key);
      if (typeof ttlSec === "number" && ttlSec > 0) {
        return ttlSec;
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Executes a zero-downtime, batch-buffered key migration between two KVDock stores or adapters.
 */
export async function migrate(options: MigrationOptions): Promise<MigrationStats> {
  const {
    source,
    target,
    batchSize = 100,
    concurrency = 5,
    pattern,
    preserveTTL = true,
    overwrite = true,
    retries = 3,
    retryDelayMs = 50,
    transformKey,
    transformValue,
    onProgress,
  } = options;

  const startTime = Date.now();
  const errors: Array<{ key: string; error: string }> = [];

  const keys = await getAllKeys(source, pattern);
  const total = keys.length;

  let copied = 0;
  let skipped = 0;
  let failed = 0;

  const emitProgress = (currentKey?: string) => {
    if (onProgress) {
      onProgress({
        total,
        copied,
        skipped,
        failed,
        currentKey,
      });
    }
  };

  emitProgress();

  async function processSingleKey(key: string): Promise<void> {
    const targetKey = transformKey ? transformKey(key) : key;
    if (targetKey === null || targetKey === undefined) {
      skipped++;
      emitProgress(key);
      return;
    }

    if (!overwrite && (await target.has(targetKey))) {
      skipped++;
      emitProgress(key);
      return;
    }

    let attempt = 0;
    while (attempt <= retries) {
      try {
        const val = await source.get(key);
        if (val === null || val === undefined) {
          skipped++;
          emitProgress(key);
          return;
        }

        const finalVal = transformValue ? transformValue(val, key) : val;
        let ttl: number | undefined;

        if (preserveTTL) {
          ttl = await getRemainingTTL(source, key);
        }

        await target.set(targetKey, finalVal, ttl ? { ttl } : undefined);
        copied++;
        emitProgress(key);
        return;
      } catch (err) {
        attempt++;
        if (attempt > retries) {
          failed++;
          const errMsg = err instanceof Error ? err.message : String(err);
          errors.push({ key, error: errMsg });
          emitProgress(key);
          return;
        }
        await delay(retryDelayMs * 2 ** (attempt - 1));
      }
    }
  }

  // Process keys in chunked batches respecting concurrency
  const effectiveBatchSize = Math.max(1, batchSize);
  for (let i = 0; i < keys.length; i += effectiveBatchSize) {
    const chunk = keys.slice(i, i + effectiveBatchSize);

    // Concurrency pool inside the batch
    const pool: Promise<void>[] = [];
    for (const key of chunk) {
      const p = processSingleKey(key).finally(() => {
        const idx = pool.indexOf(p);
        if (idx !== -1) pool.splice(idx, 1);
      });
      pool.push(p);

      if (pool.length >= concurrency) {
        await Promise.race(pool);
      }
    }

    await Promise.all(pool);
  }

  const durationMs = Date.now() - startTime;

  return {
    total,
    copied,
    skipped,
    failed,
    durationMs,
    errors,
  };
}
