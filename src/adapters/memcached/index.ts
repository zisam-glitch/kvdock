import type { AdapterCapabilities, SetOptions, StorageAdapter } from "../../core/types.js";

export interface MemcachedClientInterface {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, lifetime: number): Promise<boolean>;
  del(key: string): Promise<boolean>;
  getMulti?(keys: string[]): Promise<Record<string, string>>;
  flush?(): Promise<boolean>;
}

export interface MemcachedAdapterOptions {
  client: MemcachedClientInterface;
  prefix?: string;
  defaultTTL?: number;
}

export class MemcachedAdapter implements StorageAdapter {
  public readonly name = "memcached";
  public readonly capabilities: AdapterCapabilities = {
    ttl: true,
    batch: true,
    scan: false,
    cas: false,
    binary: false,
  };

  private readonly client: MemcachedClientInterface;
  private readonly prefix: string;
  private readonly defaultTTL: number;
  private readonly trackedKeys = new Set<string>();

  constructor(options: MemcachedAdapterOptions) {
    if (!options.client) {
      throw new Error("MemcachedAdapter requires a Memcached client instance");
    }
    this.client = options.client;
    this.prefix = options.prefix ?? "";
    this.defaultTTL = options.defaultTTL ?? 0;
  }

  private resolveKey(key: string): string {
    const prefixed = this.prefix ? `${this.prefix}${key}` : key;
    // Memcached key validation: max 250 bytes, no spaces or control characters
    if (prefixed.length > 250 || /\s/.test(prefixed)) {
      throw new Error(`Invalid Memcached key: ${key}`);
    }
    return prefixed;
  }

  private toSeconds(ttlMs?: number): number {
    const ms = ttlMs ?? this.defaultTTL;
    if (!ms || ms <= 0) return 0;
    const sec = Math.ceil(ms / 1000);
    // Standard memcached rule: if > 30 days (2592000s), convert to unix timestamp
    if (sec > 2592000) {
      return Math.floor(Date.now() / 1000) + sec;
    }
    return sec;
  }

  public async get<T = unknown>(key: string): Promise<T | null> {
    try {
      const raw = await this.client.get(this.resolveKey(key));
      if (raw === null || raw === undefined) {
        this.trackedKeys.delete(key);
        return null;
      }
      try {
        return JSON.parse(raw) as T;
      } catch {
        return raw as unknown as T;
      }
    } catch {
      return null;
    }
  }

  public async set<T = unknown>(key: string, value: T, options?: SetOptions): Promise<void> {
    if (options?.nx) {
      const exists = await this.has(key);
      if (exists) return;
    } else if (options?.xx) {
      const exists = await this.has(key);
      if (!exists) return;
    }

    const lifetime = this.toSeconds(options?.ttl);
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    const resolved = this.resolveKey(key);

    const ok = await this.client.set(resolved, serialized, lifetime);
    if (ok) {
      this.trackedKeys.add(key);
    }
  }

  public async delete(key: string): Promise<boolean> {
    try {
      const ok = await this.client.del(this.resolveKey(key));
      if (ok) {
        this.trackedKeys.delete(key);
      }
      return ok;
    } catch {
      return false;
    }
  }

  public async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== null;
  }

  public async clear(): Promise<void> {
    if (this.client.flush) {
      await this.client.flush();
    }
    this.trackedKeys.clear();
  }

  public async keys(pattern?: string): Promise<string[]> {
    const all = Array.from(this.trackedKeys);
    if (!pattern || pattern === "*") return all;
    const regex = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`);
    return all.filter((k) => regex.test(k));
  }

  public async getMany<T = unknown>(keys: string[]): Promise<Map<string, T | null>> {
    const map = new Map<string, T | null>();
    if (keys.length === 0) return map;

    if (this.client.getMulti) {
      try {
        const resolvedKeys = keys.map((k) => this.resolveKey(k));
        const res = await this.client.getMulti(resolvedKeys);
        for (const k of keys) {
          const rKey = this.resolveKey(k);
          const raw = res[rKey];
          if (raw === undefined || raw === null) {
            map.set(k, null);
          } else {
            try {
              map.set(k, JSON.parse(raw) as T);
            } catch {
              map.set(k, raw as unknown as T);
            }
          }
        }
        return map;
      } catch {
        // Fall back to parallel gets
      }
    }

    await Promise.all(
      keys.map(async (k) => {
        map.set(k, await this.get<T>(k));
      }),
    );
    return map;
  }

  public async setMany<T = unknown>(
    entries: Array<{ key: string; value: T; options?: SetOptions }>,
  ): Promise<void> {
    await Promise.all(entries.map((e) => this.set(e.key, e.value, e.options)));
  }

  public async deleteMany(keys: string[]): Promise<number> {
    let count = 0;
    await Promise.all(
      keys.map(async (k) => {
        if (await this.delete(k)) count++;
      }),
    );
    return count;
  }
}
