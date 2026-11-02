import type { AdapterCapabilities, SetOptions, StorageAdapter } from "../../core/types.js";

export interface SizedMemoryAdapterOptions {
  maxBytes?: number;
  cleanupIntervalMs?: number;
}

interface SizedInternalEntry {
  value: string;
  bytes: number;
  expiresAt: number | null;
  lastAccessed: number;
}

export class SizedMemoryAdapter implements StorageAdapter {
  public readonly name = "memory-sized";
  public readonly capabilities: AdapterCapabilities = {
    ttl: true,
    batch: true,
    scan: true,
    cas: true,
    binary: false,
    stream: false,
  };

  private readonly store = new Map<string, SizedInternalEntry>();
  private readonly maxBytes: number;
  private currentBytes = 0;
  private accessCounter = 0;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(options: SizedMemoryAdapterOptions = {}) {
    this.maxBytes = options.maxBytes ?? 50 * 1024 * 1024; // Default 50MB

    if (options.cleanupIntervalMs && options.cleanupIntervalMs > 0) {
      this.cleanupTimer = setInterval(() => {
        this.sweep();
      }, options.cleanupIntervalMs);
      if (this.cleanupTimer.unref) {
        this.cleanupTimer.unref();
      }
    }
  }

  public getByteFootprint(): number {
    return this.currentBytes;
  }

  private isExpired(entry: SizedInternalEntry): boolean {
    return entry.expiresAt !== null && entry.expiresAt <= Date.now();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) {
        this.currentBytes -= entry.bytes;
        this.store.delete(key);
      }
    }
  }

  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestAccess = Number.POSITIVE_INFINITY;

    for (const [key, entry] of this.store.entries()) {
      if (entry.lastAccessed < oldestAccess) {
        oldestAccess = entry.lastAccessed;
        oldestKey = key;
      }
    }

    if (oldestKey !== null) {
      const entry = this.store.get(oldestKey);
      if (entry) {
        this.currentBytes -= entry.bytes;
        this.store.delete(oldestKey);
      }
    }
  }

  public async get<T = unknown>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) return null;

    if (this.isExpired(entry)) {
      this.currentBytes -= entry.bytes;
      this.store.delete(key);
      return null;
    }

    entry.lastAccessed = ++this.accessCounter;

    try {
      return JSON.parse(entry.value) as T;
    } catch {
      return entry.value as unknown as T;
    }
  }

  public async set<T = unknown>(key: string, value: T, options?: SetOptions): Promise<void> {
    const serialized = JSON.stringify(value);
    // Key overhead + value byte length
    const entryBytes = Buffer.byteLength(key, "utf8") + Buffer.byteLength(serialized, "utf8");

    if (options?.nx && this.store.has(key)) {
      const existing = this.store.get(key);
      if (existing && !this.isExpired(existing)) return;
    }

    if (options?.xx && !this.store.has(key)) {
      return;
    }

    // Free existing key bytes if replacing
    const existing = this.store.get(key);
    if (existing) {
      this.currentBytes -= existing.bytes;
    }

    // Evict while over budget
    while (this.currentBytes + entryBytes > this.maxBytes && this.store.size > 0) {
      this.evictLRU();
    }

    const expiresAt = options?.ttl && options.ttl > 0 ? Date.now() + options.ttl : null;

    this.store.set(key, {
      value: serialized,
      bytes: entryBytes,
      expiresAt,
      lastAccessed: ++this.accessCounter,
    });

    this.currentBytes += entryBytes;
  }

  public async delete(key: string): Promise<boolean> {
    const entry = this.store.get(key);
    if (!entry) return false;

    this.currentBytes -= entry.bytes;
    return this.store.delete(key);
  }

  public async has(key: string): Promise<boolean> {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (this.isExpired(entry)) {
      this.currentBytes -= entry.bytes;
      this.store.delete(key);
      return false;
    }
    return true;
  }

  public async clear(): Promise<void> {
    this.store.clear();
    this.currentBytes = 0;
  }

  public async keys(pattern?: string): Promise<string[]> {
    this.sweep();
    const all = Array.from(this.store.keys());
    if (!pattern || pattern === "*") return all;

    const regex = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`);
    return all.filter((k) => regex.test(k));
  }

  public async getMany<T = unknown>(keys: string[]): Promise<Map<string, T | null>> {
    const result = new Map<string, T | null>();
    for (const key of keys) {
      result.set(key, await this.get<T>(key));
    }
    return result;
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
    for (const key of keys) {
      if (await this.delete(key)) count++;
    }
    return count;
  }

  public async disconnect(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
  }
}
