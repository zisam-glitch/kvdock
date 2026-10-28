import { TTLValidationError } from "./errors.js";
import { defaultSerializer } from "./serializer.js";

import type {
  Serializer,
  SetOptions,
  StorageAdapter,
  StoreMetrics,
  StoreOptions,
} from "./types.js";

function validateTTL(ttl: unknown): asserts ttl is number | undefined {
  if (ttl === undefined) return;
  if (typeof ttl !== "number" || !Number.isFinite(ttl) || !Number.isInteger(ttl) || ttl <= 0) {
    throw new TTLValidationError(ttl);
  }
}

export class KVDock {
  private readonly adapter: StorageAdapter;
  private readonly prefix: string;
  private readonly defaultTTL?: number;
  private readonly serializer: Serializer;
  private readonly metrics: StoreMetrics = {
    hits: 0,
    misses: 0,
    sets: 0,
    deletes: 0,
  };

  constructor(options: StoreOptions) {
    this.adapter = options.adapter;
    this.prefix = options.prefix ? `${options.prefix}:` : "";
    this.defaultTTL = options.defaultTTL;
    this.serializer = options.serializer ?? defaultSerializer;
  }

  private resolveKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  private stripPrefix(namespacedKey: string): string {
    if (!this.prefix) return namespacedKey;
    return namespacedKey.startsWith(this.prefix)
      ? namespacedKey.slice(this.prefix.length)
      : namespacedKey;
  }

  public get adapterName(): string {
    return this.adapter.name;
  }

  public get stats(): Readonly<StoreMetrics> {
    return { ...this.metrics };
  }

  public async get<T = unknown>(key: string): Promise<T | null> {
    const raw = await this.adapter.get<string>(this.resolveKey(key));
    if (raw === null || raw === undefined) {
      this.metrics.misses++;
      return null;
    }
    this.metrics.hits++;
    return this.serializer.deserialize<T>(raw);
  }

  public async set<T = unknown>(key: string, value: T, options?: SetOptions): Promise<void> {
    const ttl = options?.ttl ?? this.defaultTTL;
    validateTTL(ttl);

    const payload = this.serializer.serialize(value);
    await this.adapter.set(this.resolveKey(key), payload, { ...options, ttl });
    this.metrics.sets++;
  }

  public async delete(key: string): Promise<boolean> {
    const ok = await this.adapter.delete(this.resolveKey(key));
    if (ok) this.metrics.deletes++;
    return ok;
  }

  public async has(key: string): Promise<boolean> {
    return this.adapter.has(this.resolveKey(key));
  }

  public async clear(): Promise<void> {
    await this.adapter.clear();
  }

  public async keys(pattern?: string): Promise<string[]> {
    const rawKeys = await this.adapter.keys(pattern ? `${this.prefix}${pattern}` : undefined);
    return rawKeys.map((k) => this.stripPrefix(k));
  }

  public async getMany<T = unknown>(keys: string[]): Promise<Map<string, T | null>> {
    const result = new Map<string, T | null>();
    if (keys.length === 0) return result;

    if (this.adapter.capabilities.batch && this.adapter.getMany) {
      const namespaced = keys.map((k) => this.resolveKey(k));
      const batchResult = await this.adapter.getMany<string>(namespaced);
      for (const key of keys) {
        const raw = batchResult.get(this.resolveKey(key));
        if (raw === null || raw === undefined) {
          this.metrics.misses++;
          result.set(key, null);
        } else {
          this.metrics.hits++;
          result.set(key, this.serializer.deserialize<T>(raw));
        }
      }
      return result;
    }

    // fallback when adapter lacks native multi-get
    await Promise.all(
      keys.map(async (key) => {
        const val = await this.get<T>(key);
        result.set(key, val);
      }),
    );
    return result;
  }

  public async setMany<T = unknown>(
    entries: Array<{ key: string; value: T; options?: SetOptions }>,
  ): Promise<void> {
    if (entries.length === 0) return;

    if (this.adapter.capabilities.batch && this.adapter.setMany) {
      const mapped = entries.map((e) => {
        const ttl = e.options?.ttl ?? this.defaultTTL;
        validateTTL(ttl);
        return {
          key: this.resolveKey(e.key),
          value: this.serializer.serialize(e.value),
          options: {
            ...e.options,
            ttl,
          },
        };
      });
      await this.adapter.setMany(mapped);
      this.metrics.sets += entries.length;
      return;
    }

    // fallback loop
    await Promise.all(entries.map((e) => this.set(e.key, e.value, e.options)));
  }

  public async getOrSet<T = unknown>(
    key: string,
    fetcher: () => Promise<T> | T,
    options?: SetOptions,
  ): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) {
      return cached;
    }

    const fresh = await fetcher();
    await this.set(key, fresh, options);
    return fresh;
  }

  public async close(): Promise<void> {
    if (this.adapter.disconnect) {
      await this.adapter.disconnect();
    }
  }
}
