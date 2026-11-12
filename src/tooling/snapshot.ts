import type { KVDock } from "../core/store.js";
import type { StorageAdapter } from "../core/types.js";

export type SnapshotEndpoint = StorageAdapter | KVDock;

export interface SnapshotEntry<T = unknown> {
  key: string;
  value: T;
  ttl?: number;
}

export interface KVDockSnapshot<T = unknown> {
  version: 1;
  createdAt: number;
  entryCount: number;
  entries: Array<SnapshotEntry<T>>;
  metadata?: Record<string, unknown>;
}

export interface CreateSnapshotOptions {
  pattern?: string;
  prefix?: string;
  batchSize?: number;
  metadata?: Record<string, unknown>;
  onProgress?: (processed: number, total: number) => void;
}

export interface RestoreSnapshotOptions {
  overwrite?: boolean;
  batchSize?: number;
  keyPrefix?: string;
  transformKey?: (key: string) => string;
  onProgress?: (restored: number, total: number) => void;
}

export interface RestoreStats {
  total: number;
  restored: number;
  skipped: number;
  durationMs: number;
}

async function getKeys(endpoint: SnapshotEndpoint, pattern?: string): Promise<string[]> {
  if ("scan" in endpoint && typeof endpoint.scan === "function") {
    try {
      const keys: string[] = [];
      for await (const k of endpoint.scan(pattern)) {
        keys.push(k);
      }
      return keys;
    } catch {
      // Fallback to keys()
    }
  }

  if (typeof endpoint.keys === "function") {
    return await endpoint.keys(pattern);
  }

  return [];
}

/**
 * Creates a portable, serialized snapshot of all or matching key-value pairs from any KVDock or StorageAdapter.
 */
export async function createSnapshot<T = unknown>(
  source: SnapshotEndpoint,
  options: CreateSnapshotOptions = {},
): Promise<KVDockSnapshot<T>> {
  const allKeys = await getKeys(source, options.pattern);
  const prefix = options.prefix;
  const targetKeys = prefix ? allKeys.filter((k) => k.startsWith(prefix)) : allKeys;

  const entries: Array<SnapshotEntry<T>> = [];
  const batchSize = options.batchSize ?? 100;

  for (let i = 0; i < targetKeys.length; i += batchSize) {
    const chunk = targetKeys.slice(i, i + batchSize);
    await Promise.all(
      chunk.map(async (key) => {
        const val = await source.get<T>(key);
        if (val !== null && val !== undefined) {
          entries.push({ key, value: val });
        }
      }),
    );

    if (options.onProgress) {
      options.onProgress(Math.min(i + batchSize, targetKeys.length), targetKeys.length);
    }
  }

  return {
    version: 1,
    createdAt: Date.now(),
    entryCount: entries.length,
    entries,
    metadata: options.metadata,
  };
}

/**
 * Restores a snapshot into any target KVDock store or StorageAdapter.
 */
export async function restoreSnapshot(
  target: SnapshotEndpoint,
  snapshot: KVDockSnapshot,
  options: RestoreSnapshotOptions = {},
): Promise<RestoreStats> {
  const start = performance.now();
  const overwrite = options.overwrite ?? true;
  const batchSize = options.batchSize ?? 100;

  let restored = 0;
  let skipped = 0;

  for (let i = 0; i < snapshot.entries.length; i += batchSize) {
    const chunk = snapshot.entries.slice(i, i + batchSize);

    await Promise.all(
      chunk.map(async (entry) => {
        let finalKey = entry.key;
        if (options.transformKey) {
          finalKey = options.transformKey(finalKey);
        }
        if (options.keyPrefix) {
          finalKey = `${options.keyPrefix}${finalKey}`;
        }

        if (!overwrite) {
          const exists = await target.has(finalKey);
          if (exists) {
            skipped++;
            return;
          }
        }

        await target.set(finalKey, entry.value, entry.ttl ? { ttl: entry.ttl } : undefined);
        restored++;
      }),
    );

    if (options.onProgress) {
      options.onProgress(Math.min(i + batchSize, snapshot.entries.length), snapshot.entries.length);
    }
  }

  return {
    total: snapshot.entries.length,
    restored,
    skipped,
    durationMs: performance.now() - start,
  };
}

/**
 * Serializes a snapshot to a formatted or compact JSON string.
 */
export function exportSnapshotToJSON(snapshot: KVDockSnapshot, pretty = false): string {
  return pretty ? JSON.stringify(snapshot, null, 2) : JSON.stringify(snapshot);
}

/**
 * Deserializes a snapshot from JSON.
 */
export function importSnapshotFromJSON<T = unknown>(rawJson: string): KVDockSnapshot<T> {
  const parsed = JSON.parse(rawJson) as KVDockSnapshot<T>;
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error("Invalid KVDock snapshot format: missing version or entries array.");
  }
  return parsed;
}
