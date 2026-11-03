import type {
  AdapterCapabilities,
  ScanOptions,
  SetOptions,
  StorageAdapter,
} from "../../core/types.js";

export interface RedisClientInterface {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  exists(...keys: string[]): Promise<number>;
  flushdb?(): Promise<unknown>;
  keys(pattern: string): Promise<string[]>;
  mget?(...keys: string[]): Promise<Array<string | null>>;
  disconnect?(): Promise<void>;
}

export interface RedisAdapterOptions {
  client: RedisClientInterface;
  prefix?: string;
}

export class RedisAdapter implements StorageAdapter {
  public readonly name = "redis";
  public readonly capabilities: AdapterCapabilities = {
    ttl: true,
    batch: true,
    scan: true,
    cas: false,
    binary: false,
    stream: true,
  };

  private readonly client: RedisClientInterface;
  private readonly prefix: string;

  constructor(options: RedisAdapterOptions) {
    if (!options.client) {
      throw new Error("RedisAdapter requires a Redis client instance");
    }
    this.client = options.client;
    this.prefix = options.prefix ?? "";
  }

  private pkey(key: string): string {
    return this.prefix ? `${this.prefix}${key}` : key;
  }

  private unpkey(prefixed: string): string {
    if (this.prefix && prefixed.startsWith(this.prefix)) {
      return prefixed.slice(this.prefix.length);
    }
    return prefixed;
  }

  public async get<T = unknown>(key: string): Promise<T | null> {
    const raw = await this.client.get(this.pkey(key));
    if (raw === null || raw === undefined) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return raw as unknown as T;
    }
  }

  public async set<T = unknown>(key: string, value: T, options?: SetOptions): Promise<void> {
    const k = this.pkey(key);
    const serialized = JSON.stringify(value);
    const args: Array<string | number> = [];

    if (options?.ttl && options.ttl > 0) {
      args.push("PX", options.ttl);
    }

    if (options?.nx) {
      args.push("NX");
    } else if (options?.xx) {
      args.push("XX");
    }

    if (args.length > 0) {
      await this.client.set(k, serialized, ...args);
    } else {
      await this.client.set(k, serialized);
    }
  }

  public async delete(key: string): Promise<boolean> {
    const count = await this.client.del(this.pkey(key));
    return count > 0;
  }

  public async has(key: string): Promise<boolean> {
    const count = await this.client.exists(this.pkey(key));
    return count > 0;
  }

  public async clear(): Promise<void> {
    if (this.prefix) {
      const keys = await this.keys();
      if (keys.length > 0) {
        await this.deleteMany(keys);
      }
      return;
    }
    if (typeof this.client.flushdb === "function") {
      await this.client.flushdb();
    } else {
      const allKeys = await this.keys();
      if (allKeys.length > 0) {
        await this.deleteMany(allKeys);
      }
    }
  }

  public async keys(pattern = "*"): Promise<string[]> {
    const query = this.prefix ? `${this.prefix}${pattern}` : pattern;
    const matched = await this.client.keys(query);
    return matched.map((k) => this.unpkey(k));
  }

  public async *scan(pattern = "*", _options?: ScanOptions): AsyncIterable<string> {
    const all = await this.keys(pattern);
    for (const key of all) {
      yield key;
    }
  }

  public async getMany<T = unknown>(keys: string[]): Promise<Map<string, T | null>> {
    const result = new Map<string, T | null>();
    if (keys.length === 0) return result;

    if (typeof this.client.mget === "function") {
      const pkeys = keys.map((k) => this.pkey(k));
      const values = await this.client.mget(...pkeys);
      for (let i = 0; i < keys.length; i++) {
        const raw = values[i];
        if (raw === null || raw === undefined) {
          result.set(keys[i], null);
        } else {
          try {
            result.set(keys[i], JSON.parse(raw) as T);
          } catch {
            result.set(keys[i], raw as unknown as T);
          }
        }
      }
      return result;
    }

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
    if (keys.length === 0) return 0;
    const pkeys = keys.map((k) => this.pkey(k));
    return this.client.del(...pkeys);
  }

  public async disconnect(): Promise<void> {
    if (typeof this.client.disconnect === "function") {
      await this.client.disconnect();
    }
  }
}
