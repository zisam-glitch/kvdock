import { AdapterConnectionError, TTLValidationError } from "./errors.js";
import { createCodecSerializer, defaultSerializer } from "./serializer.js";

import type {
  KVDockEvent,
  KVDockEventType,
  KVDockLogLevel,
  KVDockLogger,
  ScanOptions,
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
  private readonly defaultTimeoutMs?: number;
  private readonly serializer: Serializer;
  private readonly logger?: KVDockLogger;
  private readonly onEvent?: (event: KVDockEvent) => void;
  private readonly inFlight = new Map<string, Promise<unknown>>();

  private readonly metrics: StoreMetrics = {
    hits: 0,
    misses: 0,
    sets: 0,
    deletes: 0,
    casSuccess: 0,
    casFailure: 0,
    stampedeCoalesced: 0,
  };

  constructor(options: StoreOptions) {
    this.adapter = options.adapter;
    this.prefix = options.prefix ? `${options.prefix}:` : "";
    this.defaultTTL = options.defaultTTL;
    this.defaultTimeoutMs = options.timeoutMs;
    this.serializer = options.codec
      ? createCodecSerializer(options.codec)
      : (options.serializer ?? defaultSerializer);
    this.logger = options.logger;
    this.onEvent = options.onEvent;
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs?: number,
    operation = "operation",
  ): Promise<T> {
    const limit = timeoutMs ?? this.defaultTimeoutMs;
    if (!limit || limit <= 0) return promise;

    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new AdapterConnectionError(
            this.adapter.name,
            new Error(`adapter ${operation} timed out after ${limit}ms`),
          ),
        );
      }, limit);
      if (timer.unref) timer.unref();
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
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

  private log(level: KVDockLogLevel, message: string, meta?: Record<string, unknown>): void {
    if (this.logger) {
      this.logger(level, message, meta);
    }
  }

  private emit(type: KVDockEventType, key?: string, meta?: Record<string, unknown>): void {
    if (this.onEvent) {
      this.onEvent({
        type,
        key,
        timestamp: Date.now(),
        meta,
      });
    }
  }

  public get adapterName(): string {
    return this.adapter.name;
  }

  public get capabilities() {
    return this.adapter.capabilities;
  }

  public get stats(): Readonly<StoreMetrics> {
    return { ...this.metrics };
  }

  public async get<T = unknown>(key: string): Promise<T | null> {
    this.log("debug", "get key", { key });
    const raw = await this.withTimeout(
      this.adapter.get<string>(this.resolveKey(key)),
      undefined,
      "get",
    );
    if (raw === null || raw === undefined) {
      this.metrics.misses++;
      this.emit("miss", key);
      return null;
    }
    this.metrics.hits++;
    this.emit("hit", key);
    return this.serializer.deserialize<T>(raw);
  }

  public async set<T = unknown>(key: string, value: T, options?: SetOptions): Promise<void> {
    const ttl = options?.ttl ?? this.defaultTTL;
    validateTTL(ttl);

    const payload = this.serializer.serialize(value);
    const resolved = this.resolveKey(key);
    await this.withTimeout(
      this.adapter.set(resolved, payload, { ...options, ttl }),
      options?.timeoutMs,
      "set",
    );
    this.metrics.sets++;
    this.emit("set", key, { ttl });
    this.log("debug", "set key", { key, ttl });

    if (options?.tags && options.tags.length > 0) {
      for (const tag of options.tags) {
        const tagKey = `__tag__:${tag}`;
        const existingRaw = await this.adapter.get<string>(this.resolveKey(tagKey));
        let keysList: string[] = [];
        if (existingRaw) {
          try {
            keysList = JSON.parse(existingRaw) as string[];
          } catch {
            keysList = [];
          }
        }
        if (!keysList.includes(resolved)) {
          keysList.push(resolved);
          await this.adapter.set(this.resolveKey(tagKey), JSON.stringify(keysList));
        }
      }
    }
  }

  public async delete(key: string): Promise<boolean> {
    const ok = await this.withTimeout(
      this.adapter.delete(this.resolveKey(key)),
      undefined,
      "delete",
    );
    if (ok) {
      this.metrics.deletes++;
      this.emit("delete", key);
      this.log("debug", "deleted key", { key });
    }
    return ok;
  }

  public async has(key: string): Promise<boolean> {
    return this.withTimeout(this.adapter.has(this.resolveKey(key)), undefined, "has");
  }

  public async clear(): Promise<void> {
    await this.withTimeout(this.adapter.clear(), undefined, "clear");
    this.emit("clear");
    this.log("info", "cache cleared");
  }

  public async keys(pattern?: string): Promise<string[]> {
    const rawKeys = await this.withTimeout(
      this.adapter.keys(pattern ? `${this.prefix}${pattern}` : undefined),
      undefined,
      "keys",
    );
    return rawKeys.filter((k) => !k.includes("__tag__:")).map((k) => this.stripPrefix(k));
  }

  public async *scan(pattern?: string, options?: ScanOptions): AsyncIterable<string> {
    const resolvedPattern = pattern ? `${this.prefix}${pattern}` : undefined;
    if (this.adapter.capabilities.scan && this.adapter.scan) {
      for await (const rawKey of this.adapter.scan(resolvedPattern, options)) {
        if (!rawKey.includes("__tag__:")) {
          yield this.stripPrefix(rawKey);
        }
      }
      return;
    }

    const allKeys = await this.keys(pattern);
    for (const key of allKeys) {
      yield key;
    }
  }

  public async compareAndSwap<T = unknown>(
    key: string,
    expected: T | null,
    update: T,
    options?: SetOptions,
  ): Promise<boolean> {
    const ttl = options?.ttl ?? this.defaultTTL;
    validateTTL(ttl);

    const resolved = this.resolveKey(key);
    const serializedUpdate = this.serializer.serialize(update);
    const serializedExpected = expected !== null ? this.serializer.serialize(expected) : null;

    if (this.adapter.capabilities.cas && this.adapter.compareAndSwap) {
      const success = await this.adapter.compareAndSwap(
        resolved,
        serializedExpected,
        serializedUpdate,
        { ...options, ttl },
      );
      if (success) {
        this.metrics.casSuccess++;
        this.emit("cas", key, { success: true });
      } else {
        this.metrics.casFailure++;
        this.emit("cas", key, { success: false });
      }
      return success;
    }

    // Reference optimistic CAS
    const current = await this.get<T>(key);
    const isExpected =
      (current === null && expected === null) ||
      (current !== null &&
        expected !== null &&
        this.serializer.serialize(current) === this.serializer.serialize(expected));

    if (!isExpected) {
      this.metrics.casFailure++;
      this.emit("cas", key, { success: false });
      return false;
    }

    await this.set(key, update, options);
    this.metrics.casSuccess++;
    this.emit("cas", key, { success: true });
    return true;
  }

  public async invalidateTag(tag: string): Promise<number> {
    const tagKey = `__tag__:${tag}`;
    const raw = await this.adapter.get<string>(this.resolveKey(tagKey));
    if (!raw) return 0;

    let keysList: string[] = [];
    try {
      keysList = JSON.parse(raw) as string[];
    } catch {
      return 0;
    }

    let deletedCount = 0;
    for (const namespacedKey of keysList) {
      const ok = await this.adapter.delete(namespacedKey);
      if (ok) {
        deletedCount++;
        this.metrics.deletes++;
      }
    }
    await this.adapter.delete(this.resolveKey(tagKey));
    this.emit("delete", tag, { tag, count: deletedCount });
    this.log("info", "invalidated tag", { tag, deletedCount });
    return deletedCount;
  }

  public async invalidateTags(tags: string[]): Promise<number> {
    let total = 0;
    for (const tag of tags) {
      total += await this.invalidateTag(tag);
    }
    return total;
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
          this.emit("miss", key);
          result.set(key, null);
        } else {
          this.metrics.hits++;
          this.emit("hit", key);
          result.set(key, this.serializer.deserialize<T>(raw));
        }
      }
      return result;
    }

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
      for (const entry of entries) {
        this.emit("set", entry.key, { ttl: entry.options?.ttl });
      }
      return;
    }

    await Promise.all(entries.map((e) => this.set(e.key, e.value, e.options)));
  }

  public async getOrSet<T = unknown>(
    key: string,
    fetcher: () => Promise<T> | T,
    options?: SetOptions,
  ): Promise<T> {
    const running = this.inFlight.get(key);
    if (running) {
      this.metrics.stampedeCoalesced++;
      this.emit("stampede_coalesced", key);
      this.log("debug", "Stampede request coalesced", { key });
      return (await running) as T;
    }

    const run = (async () => {
      try {
        const cached = await this.get<T>(key);
        if (cached !== null) {
          return cached;
        }
        const fresh = await fetcher();
        await this.set(key, fresh, options);
        return fresh;
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, run);
    return (await run) as T;
  }

  public async close(): Promise<void> {
    if (this.adapter.disconnect) {
      await this.adapter.disconnect();
    }
    this.inFlight.clear();
  }
}
