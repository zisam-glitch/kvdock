import type {
  AdapterCapabilities,
  ScanOptions,
  SetOptions,
  StorageAdapter,
} from "../../core/types.js";

export type LevelBatchOperation =
  | { type: "put"; key: string; value: string }
  | { type: "del"; key: string };

export interface LevelIteratorOptions {
  gte?: string;
  lte?: string;
  gt?: string;
  lt?: string;
  reverse?: boolean;
  limit?: number;
  keys?: boolean;
  values?: boolean;
}

export interface LevelDatabaseInterface {
  get(key: string): Promise<string>;
  put(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
  batch(operations: LevelBatchOperation[]): Promise<void>;
  clear?(options?: LevelIteratorOptions): Promise<void>;
  keys(
    options?: LevelIteratorOptions,
  ): AsyncIterable<string> | Promise<string[]> | Iterable<string>;
  values?(
    options?: LevelIteratorOptions,
  ): AsyncIterable<string> | Promise<string[]> | Iterable<string>;
  iterator?(
    options?: LevelIteratorOptions,
  ): AsyncIterable<[string, string]> | Iterable<[string, string]>;
  sublevel?(name: string, options?: unknown): LevelDatabaseInterface;
  close?(): Promise<void>;
}

export interface LevelDBAdapterOptions {
  db?: LevelDatabaseInterface;
  prefix?: string;
  defaultTTL?: number;
}

interface StoredPayload<T = unknown> {
  value: T;
  expiresAt: number | null;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

/**
 * Creates a memory-backed LevelDatabaseInterface compliant with LevelDB and sublevel semantics.
 */
export function createMemoryLevelDB(
  parentStore?: Map<string, string>,
  sublevelPrefix = "",
): LevelDatabaseInterface {
  const store = parentStore ?? new Map<string, string>();

  const resolveSubKey = (key: string): string => {
    return sublevelPrefix ? `${sublevelPrefix}${key}` : key;
  };

  const stripSubKey = (key: string): string => {
    return sublevelPrefix && key.startsWith(sublevelPrefix)
      ? key.slice(sublevelPrefix.length)
      : key;
  };

  const db: LevelDatabaseInterface = {
    async get(key: string): Promise<string> {
      const fullKey = resolveSubKey(key);
      const val = store.get(fullKey);
      if (val === undefined) {
        const error = new Error(`Key not found in database [${key}]`) as Error & {
          code: string;
          notFound: boolean;
        };
        error.code = "LEVEL_NOT_FOUND";
        error.notFound = true;
        throw error;
      }
      return val;
    },

    async put(key: string, value: string): Promise<void> {
      store.set(resolveSubKey(key), value);
    },

    async del(key: string): Promise<void> {
      store.delete(resolveSubKey(key));
    },

    async batch(operations: LevelBatchOperation[]): Promise<void> {
      for (const op of operations) {
        if (op.type === "put") {
          store.set(resolveSubKey(op.key), op.value);
        } else if (op.type === "del") {
          store.delete(resolveSubKey(op.key));
        }
      }
    },

    async clear(options?: LevelIteratorOptions): Promise<void> {
      if (!sublevelPrefix && !options?.gte && !options?.lte && !options?.gt && !options?.lt) {
        store.clear();
        return;
      }
      const toDelete: string[] = [];
      for (const k of store.keys()) {
        if (sublevelPrefix && !k.startsWith(sublevelPrefix)) continue;
        const relativeKey = stripSubKey(k);
        if (options?.gte && relativeKey < options.gte) continue;
        if (options?.lte && relativeKey > options.lte) continue;
        if (options?.gt && relativeKey <= options.gt) continue;
        if (options?.lt && relativeKey >= options.lt) continue;
        toDelete.push(k);
      }
      for (const k of toDelete) {
        store.delete(k);
      }
    },

    async *keys(options?: LevelIteratorOptions): AsyncIterable<string> {
      const matched: string[] = [];
      for (const k of store.keys()) {
        if (sublevelPrefix) {
          if (!k.startsWith(sublevelPrefix)) continue;
          const relativeKey = stripSubKey(k);
          if (options?.gte && relativeKey < options.gte) continue;
          if (options?.lte && relativeKey > options.lte) continue;
          if (options?.gt && relativeKey <= options.gt) continue;
          if (options?.lt && relativeKey >= options.lt) continue;
          matched.push(relativeKey);
        } else {
          if (options?.gte && k < options.gte) continue;
          if (options?.lte && k > options.lte) continue;
          if (options?.gt && k <= options.gt) continue;
          if (options?.lt && k >= options.lt) continue;
          matched.push(k);
        }
      }
      matched.sort();
      if (options?.reverse) {
        matched.reverse();
      }
      const limit = options?.limit ?? matched.length;
      for (let i = 0; i < Math.min(matched.length, limit); i++) {
        yield matched[i];
      }
    },

    async *iterator(options?: LevelIteratorOptions): AsyncIterable<[string, string]> {
      const keysResult = db.keys(options);
      if (Symbol.asyncIterator in keysResult) {
        for await (const key of keysResult) {
          const val = await db.get(key);
          yield [key, val];
        }
      } else if (keysResult instanceof Promise) {
        for (const key of await keysResult) {
          const val = await db.get(key);
          yield [key, val];
        }
      } else {
        for (const key of keysResult) {
          const val = await db.get(key);
          yield [key, val];
        }
      }
    },

    sublevel(name: string): LevelDatabaseInterface {
      const nextPrefix = `${sublevelPrefix}!${name}!`;
      return createMemoryLevelDB(store, nextPrefix);
    },

    async close(): Promise<void> {
      // In-memory cleanup
    },
  };

  return db;
}

export class LevelDBAdapter implements StorageAdapter {
  public readonly name = "leveldb";
  public readonly capabilities: AdapterCapabilities = {
    ttl: true,
    batch: true,
    scan: true,
    cas: true,
    binary: false,
    stream: true,
  };

  private readonly db: LevelDatabaseInterface;
  private readonly prefix: string;
  private readonly defaultTTL: number;

  constructor(options: LevelDBAdapterOptions = {}) {
    this.db = options.db ?? createMemoryLevelDB();
    this.prefix = options.prefix ?? "";
    this.defaultTTL = options.defaultTTL ?? 0;
  }

  private resolveKey(key: string): string {
    return this.prefix ? `${this.prefix}${key}` : key;
  }

  private stripPrefix(namespacedKey: string): string {
    if (this.prefix && namespacedKey.startsWith(this.prefix)) {
      return namespacedKey.slice(this.prefix.length);
    }
    return namespacedKey;
  }

  private isNotFoundError(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const e = err as { notFound?: boolean; code?: string; message?: string };
    return (
      e.notFound === true ||
      e.code === "LEVEL_NOT_FOUND" ||
      (typeof e.message === "string" && /notfound|not found/i.test(e.message))
    );
  }

  public async get<T = unknown>(key: string): Promise<T | null> {
    try {
      const raw = await this.db.get(this.resolveKey(key));
      if (raw === undefined || raw === null) return null;

      let payload: StoredPayload<T>;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && "value" in parsed) {
          payload = parsed as StoredPayload<T>;
        } else {
          payload = { value: parsed as T, expiresAt: null };
        }
      } catch {
        payload = { value: raw as unknown as T, expiresAt: null };
      }

      if (payload.expiresAt !== null && payload.expiresAt <= Date.now()) {
        await this.db.del(this.resolveKey(key)).catch(() => {});
        return null;
      }

      return payload.value;
    } catch (err: unknown) {
      if (this.isNotFoundError(err)) {
        return null;
      }
      throw err;
    }
  }

  public async set<T = unknown>(key: string, value: T, options?: SetOptions): Promise<void> {
    if (options?.nx) {
      const exists = await this.has(key);
      if (exists) return;
    }
    if (options?.xx) {
      const exists = await this.has(key);
      if (!exists) return;
    }

    const ttl = options?.ttl ?? this.defaultTTL;
    const expiresAt = ttl && ttl > 0 ? Date.now() + ttl : null;
    const payload: StoredPayload<T> = {
      value,
      expiresAt,
    };

    await this.db.put(this.resolveKey(key), JSON.stringify(payload));
  }

  public async delete(key: string): Promise<boolean> {
    const exists = await this.has(key);
    if (!exists) return false;
    try {
      await this.db.del(this.resolveKey(key));
      return true;
    } catch (err: unknown) {
      if (this.isNotFoundError(err)) return false;
      throw err;
    }
  }

  public async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== null;
  }

  public async clear(): Promise<void> {
    if (!this.prefix && this.db.clear) {
      await this.db.clear();
      return;
    }
    const allKeys = await this.keys();
    if (allKeys.length === 0) return;

    const batchOps: LevelBatchOperation[] = allKeys.map((k) => ({
      type: "del",
      key: this.resolveKey(k),
    }));
    await this.db.batch(batchOps);
  }

  public async keys(pattern?: string): Promise<string[]> {
    const matched: string[] = [];
    const regex = pattern ? globToRegExp(pattern) : null;

    const iteratorOptions: LevelIteratorOptions = {};
    if (this.prefix) {
      iteratorOptions.gte = this.prefix;
      iteratorOptions.lte = `${this.prefix}\xff`;
    }

    const rawKeysIterable = this.db.keys(iteratorOptions);
    const rawKeys: string[] = [];
    if (Symbol.asyncIterator in rawKeysIterable) {
      for await (const k of rawKeysIterable) {
        rawKeys.push(k);
      }
    } else if (rawKeysIterable instanceof Promise) {
      rawKeys.push(...(await rawKeysIterable));
    } else if (Symbol.iterator in rawKeysIterable) {
      for (const k of rawKeysIterable) {
        rawKeys.push(k);
      }
    }

    for (const rawKey of rawKeys) {
      if (this.prefix && !rawKey.startsWith(this.prefix)) continue;
      const cleanKey = this.stripPrefix(rawKey);

      if (regex && !regex.test(cleanKey)) continue;

      const val = await this.get(cleanKey);
      if (val !== null) {
        matched.push(cleanKey);
      }
    }

    return matched;
  }

  public async *scan(pattern?: string, _options?: ScanOptions): AsyncIterable<string> {
    const all = await this.keys(pattern);
    for (const key of all) {
      yield key;
    }
  }

  /**
   * Batch writes using LevelDB batch mutation array.
   */
  public async setMany<T = unknown>(
    entries: Array<{ key: string; value: T; options?: SetOptions }>,
  ): Promise<void> {
    if (entries.length === 0) return;

    const now = Date.now();
    const operations: LevelBatchOperation[] = [];

    for (const entry of entries) {
      if (entry.options?.nx || entry.options?.xx) {
        const exists = await this.has(entry.key);
        if (entry.options.nx && exists) continue;
        if (entry.options.xx && !exists) continue;
      }

      const ttl = entry.options?.ttl ?? this.defaultTTL;
      const expiresAt = ttl && ttl > 0 ? now + ttl : null;
      const payload: StoredPayload<T> = {
        value: entry.value,
        expiresAt,
      };

      operations.push({
        type: "put",
        key: this.resolveKey(entry.key),
        value: JSON.stringify(payload),
      });
    }

    if (operations.length > 0) {
      await this.db.batch(operations);
    }
  }

  public async getMany<T = unknown>(keys: string[]): Promise<Map<string, T | null>> {
    const result = new Map<string, T | null>();
    await Promise.all(
      keys.map(async (k) => {
        result.set(k, await this.get<T>(k));
      }),
    );
    return result;
  }

  /**
   * Batch deletes using LevelDB batch mutation array.
   */
  public async deleteMany(keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;

    const operations: LevelBatchOperation[] = [];
    let deletedCount = 0;

    for (const k of keys) {
      if (await this.has(k)) {
        deletedCount++;
        operations.push({
          type: "del",
          key: this.resolveKey(k),
        });
      }
    }

    if (operations.length > 0) {
      await this.db.batch(operations);
    }

    return deletedCount;
  }

  public async compareAndSwap<T = unknown>(
    key: string,
    expected: T | null,
    update: T,
    options?: SetOptions,
  ): Promise<boolean> {
    const current = await this.get<T>(key);
    const matches =
      current === expected ||
      (typeof current === "object" &&
        typeof expected === "object" &&
        JSON.stringify(current) === JSON.stringify(expected));

    if (!matches) {
      return false;
    }

    await this.set(key, update, options);
    return true;
  }

  /**
   * Creates a scoped LevelDB sublevel adapter for prefix range isolation.
   */
  public sublevel(name: string): LevelDBAdapter {
    if (this.db.sublevel) {
      const subDb = this.db.sublevel(name);
      return new LevelDBAdapter({ db: subDb, defaultTTL: this.defaultTTL });
    }
    return new LevelDBAdapter({
      db: this.db,
      prefix: `${this.prefix}${name}:`,
      defaultTTL: this.defaultTTL,
    });
  }

  /**
   * Prefix range scanning using sublevels.
   */
  public async *scanSublevel(sublevelName: string, pattern?: string): AsyncIterable<string> {
    const subAdapter = this.sublevel(sublevelName);
    for await (const k of subAdapter.scan(pattern)) {
      yield `${sublevelName}:${k}`;
    }
  }

  public async disconnect(): Promise<void> {
    if (this.db.close) {
      await this.db.close();
    }
  }
}
