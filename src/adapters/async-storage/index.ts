import { KVDockError } from "../../core/errors.js";
import type {
  AdapterCapabilities,
  ScanOptions,
  SetOptions,
  StorageAdapter,
} from "../../core/types.js";

export interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  getAllKeys(): Promise<readonly string[]>;
  multiGet?(keys: readonly string[]): Promise<readonly [string, string | null][]>;
  multiSet?(keyValuePairs: readonly [string, string][]): Promise<void>;
  multiRemove?(keys: readonly string[]): Promise<void>;
  clear?(): Promise<void>;
}

export interface AsyncStorageAdapterOptions {
  storage?: AsyncStorageLike;
  prefix?: string;
}

interface StoredEnvelope {
  v: string;
  e: number | null;
}

export class AsyncStorageAdapter implements StorageAdapter {
  public readonly name = "async-storage";
  public readonly capabilities: AdapterCapabilities = {
    ttl: true,
    batch: true,
    scan: true,
    cas: true,
    binary: false,
    stream: false,
  };

  private readonly storage: AsyncStorageLike;
  private readonly prefix: string;

  constructor(options: AsyncStorageAdapterOptions = {}) {
    this.prefix = options.prefix ?? "@kvdock:";

    if (options.storage) {
      this.storage = options.storage;
    } else {
      // In-memory fallback mock for environments where AsyncStorage is not injected
      const mem = new Map<string, string>();
      this.storage = {
        async getItem(k: string) {
          return mem.get(k) ?? null;
        },
        async setItem(k: string, v: string) {
          mem.set(k, v);
        },
        async removeItem(k: string) {
          mem.delete(k);
        },
        async getAllKeys() {
          return Array.from(mem.keys());
        },
        async multiGet(keys: readonly string[]) {
          return keys.map((k) => [k, mem.get(k) ?? null] as [string, string | null]);
        },
        async multiSet(pairs: readonly [string, string][]) {
          for (const [k, v] of pairs) {
            mem.set(k, v);
          }
        },
        async multiRemove(keys: readonly string[]) {
          for (const k of keys) {
            mem.delete(k);
          }
        },
        async clear() {
          mem.clear();
        },
      };
    }
  }

  private fullKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  private parseEnvelope(raw: string | null, key: string): StoredEnvelope | null {
    if (!raw) return null;
    try {
      const envelope = JSON.parse(raw);
      if (!envelope || typeof envelope !== "object" || !("v" in envelope)) {
        return null;
      }
      if (envelope.e !== null && typeof envelope.e === "number" && Date.now() > envelope.e) {
        this.storage.removeItem(this.fullKey(key)).catch(() => {});
        return null;
      }
      return envelope as StoredEnvelope;
    } catch {
      return null;
    }
  }

  public async get<T = unknown>(key: string): Promise<T | null> {
    try {
      const raw = await this.storage.getItem(this.fullKey(key));
      const envelope = this.parseEnvelope(raw, key);
      if (!envelope) return null;
      return envelope.v as unknown as T;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new KVDockError(`failed to get key "${key}": ${msg}`, "ERR_ADAPTER", { cause: err });
    }
  }

  public async set<T = unknown>(key: string, value: T, options?: SetOptions): Promise<void> {
    const full = this.fullKey(key);
    const existing = await this.get(key);
    const exists = existing !== null;

    if (options?.nx && exists) return;
    if (options?.xx && !exists) return;

    const expiresAt = options?.ttl ? Date.now() + options.ttl : null;
    const envelope: StoredEnvelope = {
      v: String(value),
      e: expiresAt,
    };

    try {
      await this.storage.setItem(full, JSON.stringify(envelope));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new KVDockError(`failed to set key "${key}": ${msg}`, "ERR_ADAPTER", { cause: err });
    }
  }

  public async delete(key: string): Promise<boolean> {
    const full = this.fullKey(key);
    const existing = await this.storage.getItem(full);
    if (!existing) return false;

    try {
      await this.storage.removeItem(full);
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new KVDockError(`failed to delete key "${key}": ${msg}`, "ERR_ADAPTER", { cause: err });
    }
  }

  public async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== null;
  }

  public async clear(): Promise<void> {
    try {
      const allKeys = await this.storage.getAllKeys();
      const myKeys = allKeys.filter((k) => k.startsWith(this.prefix));
      if (this.storage.multiRemove && myKeys.length > 0) {
        await this.storage.multiRemove(myKeys);
      } else {
        for (const k of myKeys) {
          await this.storage.removeItem(k);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new KVDockError(`failed to clear storage: ${msg}`, "ERR_ADAPTER", { cause: err });
    }
  }

  public async keys(pattern?: string): Promise<string[]> {
    try {
      const allKeys = await this.storage.getAllKeys();
      const matched: string[] = [];
      const regex =
        pattern && pattern !== "*" ? new RegExp(`^${pattern.replace(/\*/g, ".*")}$`) : null;

      for (const k of allKeys) {
        if (k.startsWith(this.prefix)) {
          const shortKey = k.slice(this.prefix.length);
          if (!regex || regex.test(shortKey)) {
            const val = await this.get(shortKey);
            if (val !== null) {
              matched.push(shortKey);
            }
          }
        }
      }
      return matched;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new KVDockError(`failed to list keys: ${msg}`, "ERR_ADAPTER", { cause: err });
    }
  }

  public async compareAndSwap<T = unknown>(
    key: string,
    expected: T | null,
    update: T,
    options?: SetOptions,
  ): Promise<boolean> {
    const current = await this.get<string>(key);
    const expStr = expected !== null ? String(expected) : null;

    if (current !== expStr) {
      return false;
    }

    await this.set(key, update, options);
    return true;
  }

  public async *scan(pattern?: string, _options?: ScanOptions): AsyncIterable<string> {
    const all = await this.keys(pattern);
    for (const k of all) {
      yield k;
    }
  }

  public async disconnect(): Promise<void> {
    // No-op for AsyncStorage
  }
}
