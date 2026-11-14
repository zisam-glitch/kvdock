import { createHash } from "node:crypto";
import type { KVDock } from "../../core/store.js";
import type { GetOrSetOptions } from "../../core/types.js";

export type LLMMessage = {
  role: string;
  content: string | unknown;
  [key: string]: unknown;
};

export interface LLMCacheParams {
  model?: string;
  prompt?: string;
  messages?: ReadonlyArray<LLMMessage>;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  [key: string]: unknown;
}

export interface LLMCacheOptions {
  /**
   * Target KVDock instance used for cache storage.
   */
  readonly dock: KVDock;

  /**
   * Key prefix for LLM cache entries.
   * @default "llm:cache:"
   */
  readonly keyPrefix?: string;

  /**
   * Default TTL for cached responses (in milliseconds).
   * @default 86400000 (24 hours)
   */
  readonly defaultTTL?: number;

  /**
   * Custom prompt hash function. If not provided, SHA-256 of deterministic JSON is used.
   */
  readonly hashKey?: (params: LLMCacheParams) => string;

  /**
   * Whether to automatically tag entries by model name (e.g., "model:gpt-4o")
   * allowing bulk invalidation via `dock.invalidateTag()`.
   * @default true
   */
  readonly autoTagModel?: boolean;
}

export interface LLMCacheStats {
  hits: number;
  misses: number;
  coalesced: number;
}

export interface LLMCacheEntry<T = unknown> {
  response: T;
  cachedAt: number;
  model?: string;
  paramsHash: string;
}

/**
 * Deterministically serialize parameters to ensure consistent hashes across key orders.
 */
function deterministicStringify(obj: unknown): string {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }

  if (Array.isArray(obj)) {
    return `[${obj.map(deterministicStringify).join(",")}]`;
  }

  const sortedKeys = Object.keys(obj as Record<string, unknown>).sort();
  const pairs = sortedKeys.map(
    (key) =>
      `${JSON.stringify(key)}:${deterministicStringify((obj as Record<string, unknown>)[key])}`,
  );
  return `{${pairs.join(",")}}`;
}

export function defaultHashLLMParams(params: LLMCacheParams): string {
  const canonical = deterministicStringify(params);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * LLM & Generative AI Response Caching Plugin for KVDock.
 *
 * Provides:
 * 1. Single-flight promise coalescing (prevents duplicate expensive LLM calls under concurrent load)
 * 2. Deterministic parameter hashing (prompt, messages, temperature, model)
 * 3. Model-level tag tracking for atomic invalidation (`dock.invalidateTag("model:gpt-4o")`)
 * 4. Hit/miss observability metrics
 */
export class LLMCachePlugin {
  private readonly dock: KVDock;
  private readonly keyPrefix: string;
  private readonly defaultTTL: number;
  private readonly autoTagModel: boolean;
  private readonly hashFn: (params: LLMCacheParams) => string;

  private hitsCount = 0;
  private missesCount = 0;

  constructor(options: LLMCacheOptions) {
    if (!options?.dock) {
      throw new Error("LLMCachePlugin requires a valid 'dock' instance.");
    }

    this.dock = options.dock;
    this.keyPrefix = options.keyPrefix ?? "llm:cache:";
    this.defaultTTL = options.defaultTTL ?? 86_400_000; // 24 hours
    this.autoTagModel = options.autoTagModel ?? true;
    this.hashFn = options.hashKey ?? defaultHashLLMParams;
  }

  /**
   * Generates the cache key for given LLM parameters.
   */
  public getCacheKey(params: LLMCacheParams): string {
    const hash = this.hashFn(params);
    return `${this.keyPrefix}${hash}`;
  }

  /**
   * Wraps an LLM API call with single-flight cache stampede protection.
   * Concurrent identical requests invoke the fetcher only once.
   */
  public async wrap<T>(
    params: LLMCacheParams,
    fetcher: () => Promise<T>,
    options?: { ttl?: number; tags?: string[] },
  ): Promise<T> {
    const key = this.getCacheKey(params);
    const ttl = options?.ttl ?? this.defaultTTL;

    const tags: string[] = [...(options?.tags ?? [])];
    if (this.autoTagModel && params.model) {
      tags.push(`model:${params.model}`);
    }

    const opts: GetOrSetOptions = {
      ttl,
      tags: tags.length > 0 ? tags : undefined,
    };

    let isMiss = false;
    const entry = await this.dock.getOrSet<LLMCacheEntry<T>>(
      key,
      async () => {
        isMiss = true;
        const freshResponse = await fetcher();
        return {
          response: freshResponse,
          cachedAt: Date.now(),
          model: params.model,
          paramsHash: this.hashFn(params),
        };
      },
      opts,
    );

    if (isMiss) {
      this.missesCount++;
    } else {
      this.hitsCount++;
    }

    return entry.response;
  }

  /**
   * Retrieves a cached LLM response, or null if missing/expired.
   */
  public async get<T>(params: LLMCacheParams): Promise<T | null> {
    const key = this.getCacheKey(params);
    const entry = await this.dock.get<LLMCacheEntry<T>>(key);
    if (!entry) {
      this.missesCount++;
      return null;
    }
    this.hitsCount++;
    return entry.response;
  }

  /**
   * Explicitly sets a cached LLM response.
   */
  public async set<T>(
    params: LLMCacheParams,
    response: T,
    options?: { ttl?: number; tags?: string[] },
  ): Promise<void> {
    const key = this.getCacheKey(params);
    const ttl = options?.ttl ?? this.defaultTTL;
    const tags: string[] = [...(options?.tags ?? [])];
    if (this.autoTagModel && params.model) {
      tags.push(`model:${params.model}`);
    }

    const entry: LLMCacheEntry<T> = {
      response,
      cachedAt: Date.now(),
      model: params.model,
      paramsHash: this.hashFn(params),
    };

    await this.dock.set(key, entry, { ttl, tags: tags.length > 0 ? tags : undefined });
  }

  /**
   * Invalidates a single cached prompt entry.
   */
  public async invalidate(params: LLMCacheParams): Promise<boolean> {
    const key = this.getCacheKey(params);
    return await this.dock.delete(key);
  }

  /**
   * Invalidate all cached responses for a specific model (e.g., "gpt-4o").
   */
  public async invalidateModel(model: string): Promise<number> {
    return await this.dock.invalidateTag(`model:${model}`);
  }

  /**
   * Returns hit/miss telemetry stats.
   */
  public getStats(): LLMCacheStats {
    return {
      hits: this.hitsCount,
      misses: this.missesCount,
      coalesced: this.dock.stats.stampedeCoalesced ?? 0,
    };
  }

  /**
   * Resets local counters.
   */
  public resetStats(): void {
    this.hitsCount = 0;
    this.missesCount = 0;
  }
}

/**
 * Convenience factory to create an LLM Cache Plugin.
 */
export function createLLMCachePlugin(options: LLMCacheOptions): LLMCachePlugin {
  return new LLMCachePlugin(options);
}
