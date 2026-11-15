import { KVDock } from "../../core/store.js";
import type { TieredDock } from "../../core/tiered.js";
import type { StorageAdapter } from "../../core/types.js";

export type NextCacheStore = Pick<
  KVDock | TieredDock,
  "get" | "set" | "invalidateTag" | "invalidateTags"
>;

export interface NextIncrementalCacheEntry {
  value: unknown;
  lastModified?: number;
  tags?: string[];
}

export interface NextIncrementalCacheContext {
  revalidate?: number | false;
  tags?: string[];
  softTags?: string[];
}

export interface NextCacheHandlerOptions {
  dock?: NextCacheStore;
  adapter?: StorageAdapter;
  keyPrefix?: string;
  defaultTTL?: number;
  /** Optional Next.js runtime context passed automatically by Next.js `new CacheHandler(ctx)` */
  [key: string]: unknown;
}

interface StoredCacheEnvelope {
  value: unknown;
  lastModified: number;
  tags: string[];
}

let globalDefaultOptions: NextCacheHandlerOptions | undefined;

/**
 * Drop-in Next.js IncrementalCache handler powered by KVDock.
 * Compatible with Next.js 14 and Next.js 15 App Router ISR and fetch caching.
 */
export class KVDockNextCacheHandler {
  private readonly dock: NextCacheStore;
  private readonly keyPrefix: string;
  private readonly defaultTTL?: number;

  public static configure(options: NextCacheHandlerOptions): void {
    globalDefaultOptions = options;
  }

  public constructor(options?: NextCacheHandlerOptions) {
    // Next.js calls `new CacheHandler(ctx)` passing its own runtime context object
    // (e.g. `{ serverDistDir, revalidatedTags, maxMemoryCacheSize }`).
    // Merge `globalDefaultOptions` when `options` does not directly supply `dock` or `adapter`.
    const resolvedOptions: NextCacheHandlerOptions | undefined =
      options?.dock || options?.adapter
        ? { ...globalDefaultOptions, ...options }
        : (globalDefaultOptions ?? options);

    if (!resolvedOptions) {
      throw new Error(
        "KVDockNextCacheHandler requires options with 'dock' or 'adapter', or call KVDockNextCacheHandler.configure(options) first.",
      );
    }

    if (resolvedOptions.dock) {
      this.dock = resolvedOptions.dock;
    } else if (resolvedOptions.adapter) {
      this.dock = new KVDock({ adapter: resolvedOptions.adapter });
    } else {
      throw new Error("KVDockNextCacheHandler requires either 'dock' or 'adapter' option.");
    }

    this.keyPrefix = resolvedOptions.keyPrefix ?? "nextjs:cache:";
    this.defaultTTL = resolvedOptions.defaultTTL;
  }

  private resolveKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  /**
   * Retrieves an item from the cache.
   */
  public async get(key: string): Promise<NextIncrementalCacheEntry | null> {
    const record = await this.dock.get<StoredCacheEnvelope>(this.resolveKey(key));
    if (!record) {
      return null;
    }

    return {
      value: record.value,
      lastModified: record.lastModified,
      tags: record.tags,
    };
  }

  /**
   * Stores an item in the cache with contextual tags and TTL revalidation.
   */
  public async set(key: string, data: unknown, ctx?: NextIncrementalCacheContext): Promise<void> {
    const lastModified = Date.now();
    const tags = Array.from(new Set([...(ctx?.tags ?? []), ...(ctx?.softTags ?? [])]));

    let ttl = this.defaultTTL;
    if (typeof ctx?.revalidate === "number" && ctx.revalidate > 0) {
      ttl = ctx.revalidate;
    }

    const envelope: StoredCacheEnvelope = {
      value: data,
      lastModified,
      tags,
    };

    await this.dock.set(this.resolveKey(key), envelope, {
      ttl,
      tags: tags.length > 0 ? tags : undefined,
    });
  }

  /**
   * Invalidates all cache entries associated with the specified tag(s).
   */
  public async revalidateTag(tag: string | string[]): Promise<void> {
    if (Array.isArray(tag)) {
      await this.dock.invalidateTags(tag);
    } else {
      await this.dock.invalidateTag(tag);
    }
  }

  /**
   * Optional reset hook called per request cycle by Next.js.
   */
  public resetRequestCache(): void {
    // No in-memory per-request cache to flush
  }
}

/**
 * Factory helper for Next.js cacheHandler configuration.
 */
export function createNextCacheHandler(
  options: NextCacheHandlerOptions,
): typeof KVDockNextCacheHandler {
  KVDockNextCacheHandler.configure(options);
  return class ConfiguredKVDockNextCacheHandler extends KVDockNextCacheHandler {
    public constructor(nextContext?: NextCacheHandlerOptions) {
      super({ ...options, ...nextContext, dock: options.dock, adapter: options.adapter });
    }
  };
}

export default KVDockNextCacheHandler;
