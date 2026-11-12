import { KVDock } from "../core/store.js";
import type {
  GetOrSetOptions,
  ScanOptions,
  Serializer,
  SetOptions,
  StorageAdapter,
} from "../core/types.js";

export interface MountRoute {
  readonly prefix: string;
  readonly dock: KVDock;
}

export interface RouterDockOptions {
  /**
   * Optional fallback default adapter for keys that don't match any specific mounted prefix.
   */
  readonly defaultAdapter?: StorageAdapter | KVDock;
  readonly serializer?: Serializer;
}

export class RouterDock {
  private mounts: MountRoute[] = [];
  private defaultDock?: KVDock;
  private readonly serializer?: Serializer;

  constructor(options?: RouterDockOptions) {
    this.serializer = options?.serializer;
    if (options?.defaultAdapter) {
      this.defaultDock =
        options.defaultAdapter instanceof KVDock
          ? options.defaultAdapter
          : new KVDock({ adapter: options.defaultAdapter, serializer: this.serializer });
    }
  }

  /**
   * Normalizes a mount prefix for consistent matching (e.g., "/assets/" -> "assets:").
   */
  private normalizePrefix(prefix: string): string {
    const trimmed = prefix.replace(/^\/+|\/+$/g, "").replace(/^:+|:+$/g, "");
    return trimmed.length > 0 ? `${trimmed}:` : "";
  }

  /**
   * Mounts a storage adapter or KVDock instance to a specific path/key prefix.
   */
  public mount(prefix: string, target: StorageAdapter | KVDock): this {
    const normalized = this.normalizePrefix(prefix);
    const dock =
      target instanceof KVDock
        ? target
        : new KVDock({ adapter: target, serializer: this.serializer });

    // Remove existing mount with same prefix if any
    this.mounts = this.mounts.filter((m) => m.prefix !== normalized);

    this.mounts.push({ prefix: normalized, dock });

    // Keep mounts sorted by descending prefix length for longest-prefix matching
    this.mounts.sort((a, b) => b.prefix.length - a.prefix.length);

    return this;
  }

  /**
   * Unmounts a previously mounted prefix.
   */
  public unmount(prefix: string): boolean {
    const normalized = this.normalizePrefix(prefix);
    const initialLen = this.mounts.length;
    this.mounts = this.mounts.filter((m) => m.prefix !== normalized);
    return this.mounts.length < initialLen;
  }

  /**
   * Resolves a key to its matching mounted KVDock instance and the stripped sub-key.
   */
  public resolve(key: string): { dock: KVDock; subKey: string; prefix: string } {
    const normalizedKey = key.startsWith("/") ? key.slice(1).replace(/\//g, ":") : key;

    for (const mount of this.mounts) {
      if (mount.prefix.length > 0 && normalizedKey.startsWith(mount.prefix)) {
        const subKey = normalizedKey.slice(mount.prefix.length);
        return { dock: mount.dock, subKey, prefix: mount.prefix };
      }
    }

    if (this.defaultDock) {
      return { dock: this.defaultDock, subKey: normalizedKey, prefix: "" };
    }

    throw new Error(`No storage mount matched key '${key}' and no default adapter is configured.`);
  }

  public async get<T = unknown>(key: string): Promise<T | null> {
    const { dock, subKey } = this.resolve(key);
    return dock.get<T>(subKey);
  }

  public async set<T = unknown>(key: string, value: T, options?: SetOptions): Promise<void> {
    const { dock, subKey } = this.resolve(key);
    return dock.set<T>(subKey, value, options);
  }

  public async getOrSet<T = unknown>(
    key: string,
    fetcher: () => Promise<T> | T,
    options?: GetOrSetOptions,
  ): Promise<T> {
    const { dock, subKey } = this.resolve(key);
    return dock.getOrSet<T>(subKey, fetcher, options);
  }

  public async has(key: string): Promise<boolean> {
    const { dock, subKey } = this.resolve(key);
    return dock.has(subKey);
  }

  public async delete(key: string): Promise<boolean> {
    const { dock, subKey } = this.resolve(key);
    return dock.delete(subKey);
  }

  public async compareAndSwap<T = unknown>(
    key: string,
    expected: T | null,
    update: T,
    options?: SetOptions,
  ): Promise<boolean> {
    const { dock, subKey } = this.resolve(key);
    return dock.compareAndSwap<T>(subKey, expected, update, options);
  }

  public async cas<T = unknown>(
    key: string,
    expected: T | null,
    update: T,
    options?: SetOptions,
  ): Promise<boolean> {
    return this.compareAndSwap<T>(key, expected, update, options);
  }

  public async getMany<T = unknown>(keys: string[]): Promise<Map<string, T | null>> {
    const result = new Map<string, T | null>();
    if (keys.length === 0) return result;

    // Partition keys by target dock
    const partitions = new Map<KVDock, Array<{ fullKey: string; subKey: string }>>();

    for (const key of keys) {
      const { dock, subKey } = this.resolve(key);
      const list = partitions.get(dock) ?? [];
      list.push({ fullKey: key, subKey });
      partitions.set(dock, list);
    }

    await Promise.all(
      Array.from(partitions.entries()).map(async ([dock, items]) => {
        const subKeys = items.map((i) => i.subKey);
        const batchRes = await dock.getMany<T>(subKeys);
        for (const item of items) {
          result.set(item.fullKey, batchRes.get(item.subKey) ?? null);
        }
      }),
    );

    return result;
  }

  public async setMany<T = unknown>(
    entries: Array<{ key: string; value: T; options?: SetOptions }>,
  ): Promise<void> {
    if (entries.length === 0) return;

    const partitions = new Map<KVDock, Array<{ subKey: string; value: T; options?: SetOptions }>>();

    for (const entry of entries) {
      const { dock, subKey } = this.resolve(entry.key);
      const list = partitions.get(dock) ?? [];
      list.push({ subKey, value: entry.value, options: entry.options });
      partitions.set(dock, list);
    }

    await Promise.all(
      Array.from(partitions.entries()).map(([dock, items]) =>
        dock.setMany(items.map((i) => ({ key: i.subKey, value: i.value, options: i.options }))),
      ),
    );
  }

  public async deleteMany(keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;

    const partitions = new Map<KVDock, string[]>();
    for (const key of keys) {
      const { dock, subKey } = this.resolve(key);
      const list = partitions.get(dock) ?? [];
      list.push(subKey);
      partitions.set(dock, list);
    }

    const counts = await Promise.all(
      Array.from(partitions.entries()).map(([dock, subKeys]) => dock.deleteMany(subKeys)),
    );

    return counts.reduce((acc, c) => acc + c, 0);
  }

  public async keys(pattern?: string): Promise<string[]> {
    const allKeys: string[] = [];

    await Promise.all(
      this.mounts.map(async (m) => {
        const subKeys = await m.dock.keys(pattern);
        for (const sk of subKeys) {
          allKeys.push(`${m.prefix}${sk}`);
        }
      }),
    );

    if (this.defaultDock) {
      const defKeys = await this.defaultDock.keys(pattern);
      allKeys.push(...defKeys);
    }

    return allKeys;
  }

  public async *scan(pattern?: string, options?: ScanOptions): AsyncIterable<string> {
    for (const m of this.mounts) {
      for await (const sk of m.dock.scan(pattern, options)) {
        yield `${m.prefix}${sk}`;
      }
    }

    if (this.defaultDock) {
      for await (const k of this.defaultDock.scan(pattern, options)) {
        yield k;
      }
    }
  }

  public async clear(): Promise<void> {
    await Promise.all([
      ...this.mounts.map((m) => m.dock.clear()),
      this.defaultDock ? this.defaultDock.clear() : Promise.resolve(),
    ]);
  }

  public async close(): Promise<void> {
    await Promise.all([
      ...this.mounts.map((m) => m.dock.close()),
      this.defaultDock ? this.defaultDock.close() : Promise.resolve(),
    ]);
  }
}
