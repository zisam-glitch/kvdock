import type {
  AdapterCapabilities,
  SetOptions,
  StorageAdapter,
} from "../../core/types.js";

export interface DenoKvEntry<T = unknown> {
  key: readonly unknown[];
  value: T | null;
  versionstamp: string | null;
}

export interface DenoKvAtomicCheck {
  key: readonly unknown[];
  versionstamp: string | null;
}

export interface DenoKvAtomicOperation {
  check(...checks: DenoKvAtomicCheck[]): this;
  set(key: readonly unknown[], value: unknown, options?: { expireIn?: number }): this;
  delete(key: readonly unknown[]): this;
  commit(): Promise<{ ok: boolean; versionstamp?: string }>;
}

export interface DenoKvLike {
  get<T = unknown>(
    key: readonly unknown[],
    options?: { consistency?: "strong" | "eventual" },
  ): Promise<DenoKvEntry<T>>;
  getMany<T = unknown>(
    keys: readonly (readonly unknown[])[],
  ): Promise<DenoKvEntry<T>[]>;
  set(
    key: readonly unknown[],
    value: unknown,
    options?: { expireIn?: number },
  ): Promise<{ ok: boolean; versionstamp: string }>;
  delete(key: readonly unknown[]): Promise<void>;
  list<T = unknown>(
    selector: { prefix: readonly unknown[]; start?: readonly unknown[]; end?: readonly unknown[] },
    options?: { limit?: number; cursor?: string; reverse?: boolean },
  ): AsyncIterableIterator<DenoKvEntry<T>>;
  atomic(): DenoKvAtomicOperation;
  close?(): void;
}

export interface DenoKvAdapterOptions {
  kv?: DenoKvLike;
  prefix?: string;
}

/**
 * In-memory fallback mock of DenoKvLike for zero-dependency test runner & cross-runtime usage.
 */
export class MockDenoKv implements DenoKvLike {
  private readonly store = new Map<string, { value: unknown; versionstamp: string; expiresAt?: number }>();
  private versionSeq = 1;

  private keyToString(key: readonly unknown[]): string {
    return JSON.stringify(key);
  }

  private isExpired(item: { expiresAt?: number }): boolean {
    return item.expiresAt !== undefined && item.expiresAt <= Date.now();
  }

  public async get<T = unknown>(key: readonly unknown[]): Promise<DenoKvEntry<T>> {
    const k = this.keyToString(key);
    const item = this.store.get(k);
    if (!item || this.isExpired(item)) {
      if (item) this.store.delete(k);
      return { key, value: null, versionstamp: null };
    }
    return { key, value: item.value as T, versionstamp: item.versionstamp };
  }

  public async getMany<T = unknown>(keys: readonly (readonly unknown[])[]): Promise<DenoKvEntry<T>[]> {
    const results: DenoKvEntry<T>[] = [];
    for (const key of keys) {
      results.push(await this.get<T>(key));
    }
    return results;
  }

  public async set(
    key: readonly unknown[],
    value: unknown,
    options?: { expireIn?: number },
  ): Promise<{ ok: boolean; versionstamp: string }> {
    const k = this.keyToString(key);
    const versionstamp = (this.versionSeq++).toString(16).padStart(20, "0");
    const expiresAt = options?.expireIn ? Date.now() + options.expireIn : undefined;
    this.store.set(k, { value, versionstamp, expiresAt });
    return { ok: true, versionstamp };
  }

  public async delete(key: readonly unknown[]): Promise<void> {
    const k = this.keyToString(key);
    this.store.delete(k);
  }

  public async *list<T = unknown>(
    selector: { prefix: readonly unknown[] },
  ): AsyncIterableIterator<DenoKvEntry<T>> {
    const prefixStr = this.keyToString(selector.prefix).slice(0, -1); // strip trailing ]
    for (const [k, item] of this.store.entries()) {
      if (k.startsWith(prefixStr) && !this.isExpired(item)) {
        const keyParsed = JSON.parse(k) as readonly unknown[];
        yield { key: keyParsed, value: item.value as T, versionstamp: item.versionstamp };
      }
    }
  }

  public atomic(): DenoKvAtomicOperation {
    const checks: DenoKvAtomicCheck[] = [];
    const mutations: Array<{ type: "set" | "delete"; key: readonly unknown[]; value?: unknown; expireIn?: number }> = [];

    const op: DenoKvAtomicOperation = {
      check: (...newChecks) => {
        checks.push(...newChecks);
        return op;
      },
      set: (key, value, options) => {
        mutations.push({ type: "set", key, value, expireIn: options?.expireIn });
        return op;
      },
      delete: (key) => {
        mutations.push({ type: "delete", key });
        return op;
      },
      commit: async () => {
        // Evaluate all checks atomically
        for (const chk of checks) {
          const k = this.keyToString(chk.key);
          const current = this.store.get(k);
          const currentStamp = current && !this.isExpired(current) ? current.versionstamp : null;
          if (currentStamp !== chk.versionstamp) {
            return { ok: false };
          }
        }

        // Apply mutations
        for (const mut of mutations) {
          if (mut.type === "delete") {
            this.store.delete(this.keyToString(mut.key));
          } else {
            const versionstamp = (this.versionSeq++).toString(16).padStart(20, "0");
            const expiresAt = mut.expireIn ? Date.now() + mut.expireIn : undefined;
            this.store.set(this.keyToString(mut.key), {
              value: mut.value,
              versionstamp,
              expiresAt,
            });
          }
        }

        return { ok: true, versionstamp: (this.versionSeq).toString(16).padStart(20, "0") };
      },
    };

    return op;
  }

  public close(): void {
    this.store.clear();
  }
}

/**
 * StorageAdapter for Deno KV natively supporting atomic CAS and tuple-scoped indexing.
 */
export class DenoKvAdapter implements StorageAdapter {
  public readonly name = "deno-kv";
  public readonly capabilities: AdapterCapabilities = {
    ttl: true,
    batch: true,
    scan: true,
    cas: true,
    binary: false,
    stream: true,
  };

  private readonly kv: DenoKvLike;
  private readonly prefix: string;

  public constructor(options: DenoKvAdapterOptions = {}) {
    this.prefix = options.prefix ?? "default";
    if (options.kv) {
      this.kv = options.kv;
    } else {
      const globalDeno = (globalThis as unknown as { Deno?: { openKv?: () => Promise<DenoKvLike> } }).Deno;
      if (typeof globalDeno?.openKv === "function") {
        throw new Error("Deno detected: pass opened kv instance via options.kv: await Deno.openKv()");
      } else {
        this.kv = new MockDenoKv();
      }
    }
  }

  private tuple(key: string): readonly [string, string, string] {
    return ["kvdock", this.prefix, key] as const;
  }

  public async get<T = unknown>(key: string): Promise<T | null> {
    const entry = await this.kv.get<T>(this.tuple(key));
    return entry.value;
  }

  public async set<T = unknown>(
    key: string,
    value: T,
    options?: SetOptions,
  ): Promise<void> {
    const t = this.tuple(key);
    const expireIn = options?.ttl ? options.ttl : undefined;

    if (options?.nx) {
      const res = await this.kv
        .atomic()
        .check({ key: t, versionstamp: null })
        .set(t, value, { expireIn })
        .commit();
      if (!res.ok) return;
      return;
    }

    if (options?.xx) {
      const current = await this.kv.get(t);
      if (current.versionstamp === null) return;
      const res = await this.kv
        .atomic()
        .check({ key: t, versionstamp: current.versionstamp })
        .set(t, value, { expireIn })
        .commit();
      if (!res.ok) return;
      return;
    }

    await this.kv.set(t, value, { expireIn });
  }

  public async delete(key: string): Promise<boolean> {
    const t = this.tuple(key);
    const current = await this.kv.get(t);
    if (current.versionstamp === null) return false;
    await this.kv.delete(t);
    return true;
  }

  public async has(key: string): Promise<boolean> {
    const current = await this.kv.get(this.tuple(key));
    return current.versionstamp !== null;
  }

  public async clear(): Promise<void> {
    const listPrefix = ["kvdock", this.prefix] as const;
    const entries = this.kv.list({ prefix: listPrefix });
    for await (const entry of entries) {
      await this.kv.delete(entry.key);
    }
  }

  public async keys(pattern?: string): Promise<string[]> {
    const listPrefix = ["kvdock", this.prefix] as const;
    const results: string[] = [];
    const entries = this.kv.list({ prefix: listPrefix });

    for await (const entry of entries) {
      const rawKey = entry.key[entry.key.length - 1];
      if (typeof rawKey === "string") {
        if (!pattern || pattern === "*" || rawKey.includes(pattern.replace(/\*/g, ""))) {
          results.push(rawKey);
        }
      }
    }
    return results;
  }

  public async *scan(pattern?: string): AsyncIterable<string> {
    const keyList = await this.keys(pattern);
    for (const key of keyList) {
      yield key;
    }
  }

  public async getMany<T = unknown>(keys: string[]): Promise<Map<string, T | null>> {
    const map = new Map<string, T | null>();
    const tuples = keys.map((k) => this.tuple(k));
    const entries = await this.kv.getMany<T>(tuples);

    for (let i = 0; i < keys.length; i++) {
      map.set(keys[i], entries[i]?.value ?? null);
    }
    return map;
  }

  public async setMany<T = unknown>(entries: [string, T][], options?: SetOptions): Promise<void> {
    const expireIn = options?.ttl ? options.ttl : undefined;
    const op = this.kv.atomic();
    for (const [key, value] of entries) {
      op.set(this.tuple(key), value, { expireIn });
    }
    await op.commit();
  }

  public async deleteMany(keys: string[]): Promise<number> {
    let count = 0;
    const op = this.kv.atomic();
    for (const key of keys) {
      const current = await this.kv.get(this.tuple(key));
      if (current.versionstamp !== null) {
        op.delete(this.tuple(key));
        count++;
      }
    }
    await op.commit();
    return count;
  }

  public async compareAndSwap<T = unknown>(
    key: string,
    expected: T | null,
    desired: T,
    options?: SetOptions,
  ): Promise<boolean> {
    const t = this.tuple(key);
    const expireIn = options?.ttl ? options.ttl : undefined;

    const current = await this.kv.get<T>(t);
    const currentVal = current.value;

    if (expected === null) {
      if (current.versionstamp !== null) return false;
      const res = await this.kv
        .atomic()
        .check({ key: t, versionstamp: null })
        .set(t, desired, { expireIn })
        .commit();
      return res.ok;
    }

    if (current.versionstamp === null) return false;

    // Deep equality / comparison check
    const matches =
      typeof expected === "object"
        ? JSON.stringify(currentVal) === JSON.stringify(expected)
        : currentVal === expected;

    if (!matches) return false;

    const res = await this.kv
      .atomic()
      .check({ key: t, versionstamp: current.versionstamp })
      .set(t, desired, { expireIn })
      .commit();

    return res.ok;
  }
}
