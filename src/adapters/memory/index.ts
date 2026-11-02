import type {
  AdapterCapabilities,
  ScanOptions,
  SetOptions,
  StorageAdapter,
} from "../../core/types.js";

export interface MemoryAdapterOptions {
  maxSize?: number;
  cleanupIntervalMs?: number;
}

interface InternalEntry {
  value: string;
  expiresAt: number | null;
}

export class MemoryAdapter implements StorageAdapter {
  public readonly name = "memory";
  public readonly capabilities: AdapterCapabilities = {
    ttl: true,
    batch: true,
    scan: true,
    cas: true,
    binary: false,
    stream: true,
  };

  private readonly store = new Map<string, InternalEntry>();
  private readonly maxSize: number;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(options: MemoryAdapterOptions = {}) {
    this.maxSize = options.maxSize ?? 10_000;

    // periodic sweep to avoid memory leaks from expired unread keys
    if (options.cleanupIntervalMs && options.cleanupIntervalMs > 0) {
      this.cleanupTimer = setInterval(() => {
        this.sweep();
      }, options.cleanupIntervalMs);
      if (this.cleanupTimer.unref) {
        this.cleanupTimer.unref();
      }
    }
  }

  private isExpired(entry: InternalEntry): boolean {
    return entry.expiresAt !== null && entry.expiresAt <= Date.now();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) {
        this.store.delete(key);
      }
    }
  }

  public async get<T = unknown>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) return null;

    if (this.isExpired(entry)) {
      this.store.delete(key);
      return null;
    }

    // refresh lru order
    this.store.delete(key);
    this.store.set(key, entry);

    return entry.value as unknown as T;
  }

  public async set<T = unknown>(key: string, value: T, options?: SetOptions): Promise<void> {
    const exists = this.store.has(key);
    if (options?.nx && exists) return;
    if (options?.xx && !exists) return;

    if (this.store.size >= this.maxSize && !exists) {
      // drop oldest entry
      const oldestKey = this.store.keys().next().value;
      if (oldestKey) this.store.delete(oldestKey);
    }

    const expiresAt = options?.ttl ? Date.now() + options.ttl : null;
    this.store.set(key, { value: String(value), expiresAt });
  }

  public async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }

  public async has(key: string): Promise<boolean> {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (this.isExpired(entry)) {
      this.store.delete(key);
      return false;
    }
    return true;
  }

  public async clear(): Promise<void> {
    this.store.clear();
  }

  public async keys(pattern?: string): Promise<string[]> {
    this.sweep();
    const all = Array.from(this.store.keys());
    if (!pattern || pattern === "*") return all;

    const regex = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`);
    return all.filter((k) => regex.test(k));
  }

  public async *scan(pattern?: string, _options?: ScanOptions): AsyncIterable<string> {
    this.sweep();
    const regex =
      pattern && pattern !== "*" ? new RegExp(`^${pattern.replace(/\*/g, ".*")}$`) : null;
    for (const key of this.store.keys()) {
      if (!regex || regex.test(key)) {
        yield key;
      }
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

  public async getMany<T = unknown>(keys: string[]): Promise<Map<string, T | null>> {
    const res = new Map<string, T | null>();
    for (const k of keys) {
      const v = await this.get<T>(k);
      res.set(k, v);
    }
    return res;
  }

  public async setMany<T = unknown>(
    entries: Array<{ key: string; value: T; options?: SetOptions }>,
  ): Promise<void> {
    for (const item of entries) {
      await this.set(item.key, item.value, item.options);
    }
  }

  public async deleteMany(keys: string[]): Promise<number> {
    let count = 0;
    for (const k of keys) {
      if (this.store.delete(k)) count++;
    }
    return count;
  }

  public async disconnect(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    this.store.clear();
  }
}
