import { AdapterConnectionError, TTLValidationError } from "./errors.js";
import { createCodecSerializer, defaultSerializer } from "./serializer.js";

import type {
  GetOrSetOptions,
  KVDockEvent,
  KVDockEventType,
  KVDockLogLevel,
  KVDockLogger,
  ScanOptions,
  Serializer,
  SetOptions,
  StorageAdapter,
  StoreInterceptor,
  StoreMetrics,
  StoreOptions,
  WatchEvent,
  WatchHandler,
} from "./types.js";

interface SwrEnvelope<T = unknown> {
  readonly __kvdock_swr__: true;
  readonly v: T;
  readonly savedAt: number;
  readonly freshUntil: number;
  readonly staleUntil: number;
  readonly graceUntil?: number;
  readonly deltaMs: number;
}

function isSwrEnvelope<T = unknown>(value: unknown): value is SwrEnvelope<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    "__kvdock_swr__" in value &&
    (value as Record<string, unknown>).__kvdock_swr__ === true &&
    "v" in value
  );
}

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
  private readonly backgroundInFlight = new Map<string, Promise<unknown>>();
  private readonly interceptors: StoreInterceptor[] = [];
  private readonly watchers = new Set<WatchHandler<unknown>>();

  private readonly metrics: StoreMetrics = {
    hits: 0,
    misses: 0,
    sets: 0,
    deletes: 0,
    casSuccess: 0,
    casFailure: 0,
    stampedeCoalesced: 0,
    staleHits: 0,
    graceHits: 0,
    backgroundRefreshes: 0,
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

  /**
   * Registers a bidirectional middleware interceptor for transformation, validation, or observability.
   */
  public use(interceptor: StoreInterceptor): this {
    this.interceptors.push(interceptor);
    return this;
  }

  /**
   * Subscribes to real-time cache mutations (set, delete, clear).
   */
  public watch<T = unknown>(handler: WatchHandler<T>): () => void {
    const fn = handler as WatchHandler<unknown>;
    this.watchers.add(fn);
    return () => {
      this.watchers.delete(fn);
    };
  }

  private notifyWatchers(event: WatchEvent<unknown>): void {
    for (const watcher of this.watchers) {
      try {
        void watcher(event);
      } catch {
        // Suppress watcher errors
      }
    }
  }

  public async get<T = unknown>(key: string): Promise<T | null> {
    let currentKey = key;
    for (const interceptor of this.interceptors) {
      if (interceptor.beforeGet) {
        currentKey = await interceptor.beforeGet(currentKey);
      }
    }

    const start = performance.now();
    this.log("debug", "get key", { key: currentKey });
    let raw: string | null = null;
    try {
      raw = await this.withTimeout(
        this.adapter.get<string>(this.resolveKey(currentKey)),
        undefined,
        "get",
      );
    } catch (err) {
      for (const interceptor of this.interceptors) {
        if (interceptor.onError) {
          await interceptor.onError("get", currentKey, err);
        }
      }
      throw err;
    }

    const durationMs = performance.now() - start;
    if (raw === null || raw === undefined) {
      this.metrics.misses++;
      this.emit("miss", currentKey, { durationMs });
      let result: T | null = null;
      for (const interceptor of this.interceptors) {
        if (interceptor.afterGet) {
          result = await interceptor.afterGet<T>(currentKey, result);
        }
      }
      return result;
    }
    this.metrics.hits++;
    this.emit("hit", currentKey, { durationMs });
    const parsed = this.serializer.deserialize<unknown>(raw);
    let val = (isSwrEnvelope<T>(parsed) ? parsed.v : parsed) as T | null;

    for (const interceptor of this.interceptors) {
      if (interceptor.afterGet) {
        val = await interceptor.afterGet<T>(currentKey, val);
      }
    }

    return val;
  }

  public async set<T = unknown>(key: string, value: T, options?: SetOptions): Promise<void> {
    let currentKey = key;
    let currentValue = value;
    let currentOptions = options;

    for (const interceptor of this.interceptors) {
      if (interceptor.beforeSet) {
        const transformed = await interceptor.beforeSet(currentKey, currentValue, currentOptions);
        if (transformed.key !== undefined) currentKey = transformed.key;
        if (transformed.value !== undefined) currentValue = transformed.value as T;
        if (transformed.options !== undefined) currentOptions = transformed.options;
      }
    }

    const start = performance.now();
    const ttl = currentOptions?.ttl ?? this.defaultTTL;
    validateTTL(ttl);

    const payload = this.serializer.serialize(currentValue);
    const resolved = this.resolveKey(currentKey);
    try {
      await this.withTimeout(
        this.adapter.set(resolved, payload, { ...currentOptions, ttl }),
        currentOptions?.timeoutMs,
        "set",
      );
    } catch (err) {
      for (const interceptor of this.interceptors) {
        if (interceptor.onError) {
          await interceptor.onError("set", currentKey, err);
        }
      }
      throw err;
    }

    const durationMs = performance.now() - start;
    this.metrics.sets++;
    this.emit("set", currentKey, { ttl, durationMs });
    this.log("debug", "set key", { key: currentKey, ttl });

    if (currentOptions?.tags && currentOptions.tags.length > 0) {
      for (const tag of currentOptions.tags) {
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

    for (const interceptor of this.interceptors) {
      if (interceptor.afterSet) {
        await interceptor.afterSet(currentKey, currentValue, currentOptions);
      }
    }

    this.notifyWatchers({ type: "set", key: currentKey, value: currentValue });
  }

  public async delete(key: string): Promise<boolean> {
    let currentKey = key;
    for (const interceptor of this.interceptors) {
      if (interceptor.beforeDelete) {
        currentKey = await interceptor.beforeDelete(currentKey);
      }
    }

    const start = performance.now();
    let ok = false;
    try {
      ok = await this.withTimeout(
        this.adapter.delete(this.resolveKey(currentKey)),
        undefined,
        "delete",
      );
    } catch (err) {
      for (const interceptor of this.interceptors) {
        if (interceptor.onError) {
          await interceptor.onError("delete", currentKey, err);
        }
      }
      throw err;
    }

    const durationMs = performance.now() - start;
    if (ok) {
      this.metrics.deletes++;
      this.emit("delete", currentKey, { durationMs });
      this.log("debug", "deleted key", { key: currentKey });
      this.notifyWatchers({ type: "delete", key: currentKey });
    }
    return ok;
  }

  public async deleteMany(keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    if (this.adapter.capabilities.batch && this.adapter.deleteMany) {
      const resolvedKeys = keys.map((k) => this.resolveKey(k));
      const count = await this.withTimeout(
        this.adapter.deleteMany(resolvedKeys),
        undefined,
        "deleteMany",
      );
      this.metrics.deletes += count;
      return count;
    }
    const results = await Promise.all(keys.map((k) => this.delete(k)));
    return results.filter(Boolean).length;
  }

  public async has(key: string): Promise<boolean> {
    return this.withTimeout(this.adapter.has(this.resolveKey(key)), undefined, "has");
  }

  public async clear(): Promise<void> {
    const start = performance.now();
    await this.withTimeout(this.adapter.clear(), undefined, "clear");
    const durationMs = performance.now() - start;
    this.emit("clear", undefined, { durationMs });
    this.log("info", "cache cleared");
    this.notifyWatchers({ type: "clear" });
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
    const start = performance.now();
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
      const durationMs = performance.now() - start;
      if (success) {
        this.metrics.casSuccess++;
        this.emit("cas", key, { success: true, durationMs });
      } else {
        this.metrics.casFailure++;
        this.emit("cas", key, { success: false, durationMs });
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

    const durationMs = performance.now() - start;
    if (!isExpected) {
      this.metrics.casFailure++;
      this.emit("cas", key, { success: false, durationMs });
      return false;
    }

    await this.set(key, update, options);
    this.metrics.casSuccess++;
    this.emit("cas", key, { success: true, durationMs });
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
          const parsed = this.serializer.deserialize<unknown>(raw);
          result.set(key, (isSwrEnvelope<T>(parsed) ? parsed.v : parsed) as T);
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
    options?: GetOrSetOptions,
  ): Promise<T> {
    const swrWindow = options?.staleWhileRevalidate;
    const isXFetch = options?.xfetch ?? false;
    const beta = options?.beta ?? 1.0;
    const gracePeriodMs = options?.gracePeriodMs;
    const fallbackOnFetcherError =
      options?.fallbackOnFetcherError ?? (gracePeriodMs !== undefined && gracePeriodMs > 0);
    const usesEnvelope =
      (swrWindow !== undefined && swrWindow > 0) ||
      isXFetch ||
      (gracePeriodMs !== undefined && gracePeriodMs > 0);

    const running = this.inFlight.get(key);
    if (running) {
      this.metrics.stampedeCoalesced++;
      this.emit("stampede_coalesced", key);
      this.log("debug", "Stampede request coalesced", { key });
      return (await running) as T;
    }

    const triggerBackgroundRefresh = () => {
      if (this.backgroundInFlight.has(key)) return;
      this.metrics.backgroundRefreshes++;
      this.emit("background_refresh", key);
      this.log("debug", "Triggering background cache refresh", { key });

      const bgTask = (async () => {
        try {
          const start = performance.now();
          const fresh = await fetcher();
          const deltaMs = performance.now() - start;

          const baseTTL = options?.ttl ?? this.defaultTTL;
          const totalTTL = baseTTL ? baseTTL + (swrWindow ?? 0) + (gracePeriodMs ?? 0) : undefined;
          const now = Date.now();

          const envelope: SwrEnvelope<T> = {
            __kvdock_swr__: true,
            v: fresh,
            savedAt: now,
            freshUntil: baseTTL ? now + baseTTL : Number.POSITIVE_INFINITY,
            staleUntil: baseTTL ? now + baseTTL + (swrWindow ?? 0) : Number.POSITIVE_INFINITY,
            graceUntil: totalTTL ? now + totalTTL : Number.POSITIVE_INFINITY,
            deltaMs,
          };

          await this.set(key, envelope, { ...options, ttl: totalTTL });
        } catch (err) {
          this.log("warn", "Background refresh failed", { key, error: String(err) });
        } finally {
          this.backgroundInFlight.delete(key);
        }
      })();

      this.backgroundInFlight.set(key, bgTask);
    };

    const run = (async () => {
      let cachedFallback: SwrEnvelope<T> | undefined;

      try {
        const raw = await this.withTimeout(
          this.adapter.get<string>(this.resolveKey(key)),
          undefined,
          "get",
        );

        if (raw !== null && raw !== undefined) {
          const parsed = this.serializer.deserialize<unknown>(raw);

          if (isSwrEnvelope<T>(parsed)) {
            cachedFallback = parsed;
            const now = Date.now();
            const isFresh = now < parsed.freshUntil;
            const isStale = !isFresh && now < parsed.staleUntil;

            if (isFresh) {
              if (isXFetch) {
                const delta = parsed.deltaMs >= 1 ? parsed.deltaMs : 10;
                const randGen = options?.randomFn ?? Math.random;
                const rand = Math.max(0.0001, randGen());
                const timeUntilExpiry = parsed.freshUntil - now;
                const earlyRecompute = -delta * beta * Math.log(rand) > timeUntilExpiry;

                if (earlyRecompute) {
                  triggerBackgroundRefresh();
                }
              }
              this.metrics.hits++;
              this.emit("hit", key);
              return parsed.v;
            }

            if (isStale) {
              this.metrics.hits++;
              this.metrics.staleHits++;
              this.emit("hit", key);
              this.emit("stale_hit", key);
              triggerBackgroundRefresh();
              return parsed.v;
            }
          } else {
            this.metrics.hits++;
            this.emit("hit", key);
            return parsed as T;
          }
        }

        try {
          const start = performance.now();
          const fresh = await fetcher();
          const deltaMs = performance.now() - start;

          if (usesEnvelope) {
            const baseTTL = options?.ttl ?? this.defaultTTL;
            const totalTTL = baseTTL
              ? baseTTL + (swrWindow ?? 0) + (gracePeriodMs ?? 0)
              : undefined;
            const now = Date.now();

            const envelope: SwrEnvelope<T> = {
              __kvdock_swr__: true,
              v: fresh,
              savedAt: now,
              freshUntil: baseTTL ? now + baseTTL : Number.POSITIVE_INFINITY,
              staleUntil: baseTTL ? now + baseTTL + (swrWindow ?? 0) : Number.POSITIVE_INFINITY,
              graceUntil: totalTTL ? now + totalTTL : Number.POSITIVE_INFINITY,
              deltaMs,
            };

            await this.set(key, envelope, { ...options, ttl: totalTTL });
          } else {
            await this.set(key, fresh, options);
          }

          return fresh;
        } catch (fetchErr) {
          if (fallbackOnFetcherError && cachedFallback) {
            const now = Date.now();
            const graceLimit =
              cachedFallback.graceUntil ?? cachedFallback.staleUntil + (gracePeriodMs ?? 0);
            if (now < graceLimit || gracePeriodMs === undefined) {
              this.metrics.hits++;
              this.metrics.graceHits++;
              this.emit("hit", key);
              this.emit("grace_hit", key, { error: String(fetchErr) });
              this.log("warn", "Fetcher failed: serving cached content in Grace Mode", {
                key,
                error: String(fetchErr),
              });
              return cachedFallback.v;
            }
          }
          throw fetchErr;
        }
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
    this.backgroundInFlight.clear();
  }
}
