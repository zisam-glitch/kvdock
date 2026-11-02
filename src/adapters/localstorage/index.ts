import { KVDockError } from "../../core/errors.js";
import type {
  AdapterCapabilities,
  ScanOptions,
  SetOptions,
  StorageAdapter,
} from "../../core/types.js";

export interface LocalStorageAdapterOptions {
  storage?: Storage;
  prefix?: string;
  cleanupIntervalMs?: number;
}

interface StoredEnvelope {
  v: string;
  e: number | null;
}

export class LocalStorageAdapter implements StorageAdapter {
  public readonly name = "localstorage";
  public readonly capabilities: AdapterCapabilities = {
    ttl: true,
    batch: true,
    scan: true,
    cas: true,
    binary: false,
    stream: false,
  };

  private readonly storage: Storage;
  private readonly prefix: string;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(options: LocalStorageAdapterOptions = {}) {
    this.prefix = options.prefix ?? "kvdock:";
    if (options.storage) {
      this.storage = options.storage;
    } else if (
      typeof globalThis !== "undefined" &&
      "localStorage" in globalThis &&
      (globalThis as unknown as { localStorage?: Storage }).localStorage
    ) {
      this.storage = (globalThis as unknown as { localStorage: Storage }).localStorage;
    } else {
      const memoryFallback = new Map<string, string>();
      this.storage = {
        get length() {
          return memoryFallback.size;
        },
        clear() {
          memoryFallback.clear();
        },
        getItem(key: string) {
          return memoryFallback.get(key) ?? null;
        },
        key(index: number) {
          return Array.from(memoryFallback.keys())[index] ?? null;
        },
        removeItem(key: string) {
          memoryFallback.delete(key);
        },
        setItem(key: string, value: string) {
          memoryFallback.set(key, value);
        },
      } as Storage;
    }

    if (options.cleanupIntervalMs && options.cleanupIntervalMs > 0) {
      this.cleanupTimer = setInterval(() => {
        this.sweep();
      }, options.cleanupIntervalMs);
      if (this.cleanupTimer.unref) {
        this.cleanupTimer.unref();
      }
    }
  }

  private fullKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  private parseEnvelope(raw: string | null, key: string): StoredEnvelope | null {
    if (!raw) return null;
    try {
      const envelope: StoredEnvelope = JSON.parse(raw);
      if (envelope.e !== null && Date.now() > envelope.e) {
        this.storage.removeItem(this.fullKey(key));
        return null;
      }
      return envelope;
    } catch {
      return null;
    }
  }

  public async get<T = unknown>(key: string): Promise<T | null> {
    const raw = this.storage.getItem(this.fullKey(key));
    const envelope = this.parseEnvelope(raw, key);
    if (!envelope) return null;
    return envelope.v as unknown as T;
  }

  public async set<T = unknown>(key: string, value: T, options?: SetOptions): Promise<void> {
    const full = this.fullKey(key);
    const existingRaw = this.storage.getItem(full);
    const existing = this.parseEnvelope(existingRaw, key);
    const exists = existing !== null;

    if (options?.nx && exists) return;
    if (options?.xx && !exists) return;

    const expiresAt = options?.ttl ? Date.now() + options.ttl : null;
    const envelope: StoredEnvelope = {
      v: String(value),
      e: expiresAt,
    };

    try {
      this.storage.setItem(full, JSON.stringify(envelope));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new KVDockError(`failed to write key "${key}" to localstorage: ${msg}`, "ERR_ADAPTER", {
        cause: err,
      });
    }
  }

  public async delete(key: string): Promise<boolean> {
    const full = this.fullKey(key);
    const raw = this.storage.getItem(full);
    if (!raw) return false;
    this.storage.removeItem(full);
    return true;
  }

  public async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== null;
  }

  public async clear(): Promise<void> {
    const keysToRemove: string[] = [];
    for (let i = 0; i < this.storage.length; i++) {
      const k = this.storage.key(i);
      if (k?.startsWith(this.prefix)) {
        keysToRemove.push(k);
      }
    }
    for (const k of keysToRemove) {
      this.storage.removeItem(k);
    }
  }

  public async keys(pattern?: string): Promise<string[]> {
    this.sweep();
    const matched: string[] = [];
    const regex =
      pattern && pattern !== "*" ? new RegExp(`^${pattern.replace(/\*/g, ".*")}$`) : null;

    for (let i = 0; i < this.storage.length; i++) {
      const k = this.storage.key(i);
      if (k?.startsWith(this.prefix)) {
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
  }

  public async getMany<T = unknown>(keys: string[]): Promise<Map<string, T | null>> {
    const res = new Map<string, T | null>();
    for (const k of keys) {
      const val = await this.get<T>(k);
      res.set(k, val);
    }
    return res;
  }

  public async setMany<T = unknown>(
    entries: Array<{ key: string; value: T; options?: SetOptions }>,
  ): Promise<void> {
    for (const entry of entries) {
      await this.set(entry.key, entry.value, entry.options);
    }
  }

  public async deleteMany(keys: string[]): Promise<number> {
    let count = 0;
    for (const k of keys) {
      if (await this.delete(k)) count++;
    }
    return count;
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
    const matchedKeys = await this.keys(pattern);
    for (const k of matchedKeys) {
      yield k;
    }
  }

  public sweep(): void {
    const now = Date.now();
    const allKeys: string[] = [];
    for (let i = 0; i < this.storage.length; i++) {
      const rawKey = this.storage.key(i);
      if (rawKey?.startsWith(this.prefix)) {
        allKeys.push(rawKey);
      }
    }

    for (const rawKey of allKeys) {
      const raw = this.storage.getItem(rawKey);
      if (!raw) continue;
      try {
        const envelope: StoredEnvelope = JSON.parse(raw);
        if (envelope.e !== null && now > envelope.e) {
          this.storage.removeItem(rawKey);
        }
      } catch {
        this.storage.removeItem(rawKey);
      }
    }
  }

  public async disconnect(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    await this.clear();
  }
}
