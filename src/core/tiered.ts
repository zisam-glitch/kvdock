import { KVDock } from "./store.js";
import type {
  KVDockEvent,
  KVDockLogger,
  Serializer,
  SetOptions,
  StorageAdapter,
  StoreMetrics,
} from "./types.js";

export interface TieredDockOptions {
  l1: StorageAdapter;
  l2: StorageAdapter;
  prefix?: string;
  defaultTTL?: number;
  l1TTL?: number;
  serializer?: Serializer;
  logger?: KVDockLogger;
  onEvent?: (event: KVDockEvent) => void;
}

export interface TieredStoreMetrics extends StoreMetrics {
  l1Hits: number;
  l2Hits: number;
  promotions: number;
}

export class TieredDock {
  private readonly l1Dock: KVDock;
  private readonly l2Dock: KVDock;
  private readonly l1TTL?: number;
  private readonly inFlight = new Map<string, Promise<unknown>>();

  private readonly tieredMetrics: TieredStoreMetrics = {
    hits: 0,
    misses: 0,
    sets: 0,
    deletes: 0,
    casSuccess: 0,
    casFailure: 0,
    stampedeCoalesced: 0,
    l1Hits: 0,
    l2Hits: 0,
    promotions: 0,
  };

  constructor(options: TieredDockOptions) {
    this.l1TTL = options.l1TTL;

    this.l1Dock = new KVDock({
      adapter: options.l1,
      prefix: options.prefix,
      defaultTTL: options.l1TTL ?? options.defaultTTL,
      serializer: options.serializer,
      logger: options.logger,
      onEvent: options.onEvent,
    });

    this.l2Dock = new KVDock({
      adapter: options.l2,
      prefix: options.prefix,
      defaultTTL: options.defaultTTL,
      serializer: options.serializer,
      logger: options.logger,
      onEvent: options.onEvent,
    });
  }

  public get stats(): Readonly<TieredStoreMetrics> {
    return { ...this.tieredMetrics };
  }

  public async get<T = unknown>(key: string): Promise<T | null> {
    // 1. Check L1 cache
    const l1Val = await this.l1Dock.get<T>(key);
    if (l1Val !== null) {
      this.tieredMetrics.hits++;
      this.tieredMetrics.l1Hits++;
      return l1Val;
    }

    // 2. Check L2 cache
    const l2Val = await this.l2Dock.get<T>(key);
    if (l2Val !== null) {
      this.tieredMetrics.hits++;
      this.tieredMetrics.l2Hits++;
      this.tieredMetrics.promotions++;

      // Promote back to L1
      await this.l1Dock.set(key, l2Val, { ttl: this.l1TTL });
      return l2Val;
    }

    this.tieredMetrics.misses++;
    return null;
  }

  public async set<T = unknown>(key: string, value: T, options?: SetOptions): Promise<void> {
    const l1Options = this.l1TTL ? { ...options, ttl: this.l1TTL } : options;
    await Promise.all([
      this.l1Dock.set(key, value, l1Options),
      this.l2Dock.set(key, value, options),
    ]);
    this.tieredMetrics.sets++;
  }

  public async delete(key: string): Promise<boolean> {
    const [ok1, ok2] = await Promise.all([this.l1Dock.delete(key), this.l2Dock.delete(key)]);
    const ok = ok1 || ok2;
    if (ok) {
      this.tieredMetrics.deletes++;
    }
    return ok;
  }

  public async has(key: string): Promise<boolean> {
    const hasL1 = await this.l1Dock.has(key);
    if (hasL1) return true;
    return this.l2Dock.has(key);
  }

  public async clear(): Promise<void> {
    await Promise.all([this.l1Dock.clear(), this.l2Dock.clear()]);
  }

  public async keys(pattern?: string): Promise<string[]> {
    const [l1Keys, l2Keys] = await Promise.all([
      this.l1Dock.keys(pattern),
      this.l2Dock.keys(pattern),
    ]);
    return Array.from(new Set([...l1Keys, ...l2Keys]));
  }

  public async getOrSet<T = unknown>(
    key: string,
    fetcher: () => Promise<T> | T,
    options?: SetOptions,
  ): Promise<T> {
    const inFlightPromise = this.inFlight.get(key);
    if (inFlightPromise) {
      this.tieredMetrics.stampedeCoalesced++;
      return (await inFlightPromise) as T;
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
    await Promise.all([this.l1Dock.close(), this.l2Dock.close()]);
    this.inFlight.clear();
  }
}
