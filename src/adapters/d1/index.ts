import { KVDockError } from "../../core/errors.js";
import type {
  AdapterCapabilities,
  ScanOptions,
  SetOptions,
  StorageAdapter,
} from "../../core/types.js";

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<{ success: boolean }>;
  all<T = unknown>(): Promise<{ success: boolean; results: T[] }>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
}

export interface D1AdapterOptions {
  db?: D1DatabaseLike;
  tableName?: string;
}

export class D1Adapter implements StorageAdapter {
  public readonly name = "d1";
  public readonly capabilities: AdapterCapabilities = {
    ttl: true,
    batch: true,
    scan: true,
    cas: true,
    binary: false,
    stream: false,
  };

  private readonly db: D1DatabaseLike;
  private readonly tableName: string;

  constructor(options: D1AdapterOptions = {}) {
    this.tableName = options.tableName ?? "kvdock";

    if (options.db) {
      this.db = options.db;
    } else {
      // In-memory mock fallback when running outside of Cloudflare Workers
      const mem = new Map<string, { value: string; expires_at: number | null }>();
      this.db = {
        prepare: (sql: string) => {
          let boundArgs: unknown[] = [];
          const stmt: D1PreparedStatementLike = {
            bind(...args: unknown[]) {
              boundArgs = args;
              return stmt;
            },
            async first<T = unknown>() {
              const key = String(boundArgs[0]);
              const row = mem.get(key);
              if (!row) return null;
              if (row.expires_at !== null && Date.now() > row.expires_at) {
                mem.delete(key);
                return null;
              }
              if (sql.includes("SELECT 1")) {
                return { 1: 1 } as unknown as T;
              }
              if (sql.includes("SELECT value, expires_at")) {
                return row as unknown as T;
              }
              return row as unknown as T;
            },
            async run() {
              if (sql.includes("INSERT OR REPLACE")) {
                const [k, v, exp] = boundArgs;
                mem.set(String(k), {
                  value: String(v),
                  expires_at: (exp as number | null) ?? null,
                });
                return { success: true };
              }
              if (sql.includes("DELETE FROM") && boundArgs.length > 0) {
                mem.delete(String(boundArgs[0]));
                return { success: true };
              }
              if (sql.includes("DELETE FROM") && boundArgs.length === 0) {
                mem.clear();
                return { success: true };
              }
              return { success: true };
            },
            async all<T = unknown>() {
              if (sql.includes("SELECT key FROM")) {
                const now = Date.now();
                const results: Array<{ key: string }> = [];
                for (const [k, r] of mem.entries()) {
                  if (r.expires_at === null || now <= r.expires_at) {
                    results.push({ key: k });
                  }
                }
                return { success: true, results: results as unknown as T[] };
              }
              return { success: true, results: [] };
            },
          };
          return stmt;
        },
      };
    }

    this.initTable().catch(() => {});
  }

  private async initTable(): Promise<void> {
    try {
      await this.db
        .prepare(
          `CREATE TABLE IF NOT EXISTS "${this.tableName}" (key TEXT PRIMARY KEY, value TEXT, expires_at INTEGER);`,
        )
        .run();
    } catch {
      // safe fallback
    }
  }

  public async get<T = unknown>(key: string): Promise<T | null> {
    try {
      const row = await this.db
        .prepare(`SELECT value, expires_at FROM "${this.tableName}" WHERE key = ?;`)
        .bind(key)
        .first<{ value: string; expires_at: number | null }>();

      if (!row) return null;
      if (row.expires_at !== null && Date.now() > row.expires_at) {
        await this.db.prepare(`DELETE FROM "${this.tableName}" WHERE key = ?;`).bind(key).run();
        return null;
      }

      return row.value as unknown as T;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new KVDockError(`failed to get key "${key}": ${msg}`, "ERR_ADAPTER", { cause: err });
    }
  }

  public async set<T = unknown>(key: string, value: T, options?: SetOptions): Promise<void> {
    const existing = await this.get(key);
    const exists = existing !== null;

    if (options?.nx && exists) return;
    if (options?.xx && !exists) return;

    const expiresAt = options?.ttl ? Date.now() + options.ttl : null;

    try {
      await this.db
        .prepare(
          `INSERT OR REPLACE INTO "${this.tableName}" (key, value, expires_at) VALUES (?, ?, ?);`,
        )
        .bind(key, String(value), expiresAt)
        .run();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new KVDockError(`failed to set key "${key}": ${msg}`, "ERR_ADAPTER", { cause: err });
    }
  }

  public async delete(key: string): Promise<boolean> {
    try {
      const existing = await this.db
        .prepare(`SELECT 1 FROM "${this.tableName}" WHERE key = ?;`)
        .bind(key)
        .first();
      if (!existing) return false;

      await this.db.prepare(`DELETE FROM "${this.tableName}" WHERE key = ?;`).bind(key).run();
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new KVDockError(`failed to delete key "${key}": ${msg}`, "ERR_ADAPTER", { cause: err });
    }
  }

  public async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== null;
  }

  public async getMany<T = unknown>(keys: string[]): Promise<Map<string, T | null>> {
    const res = new Map<string, T | null>();
    for (const k of keys) {
      res.set(k, await this.get<T>(k));
    }
    return res;
  }

  public async setMany<T = unknown>(
    entries: Array<{ key: string; value: T; options?: SetOptions }>,
  ): Promise<void> {
    for (const entry of entries) {
      await this.set(entry.key, entry.value, entry.options);
    }
  }

  public async deleteMany(keys: string[]): Promise<number> {
    let count = 0;
    for (const k of keys) {
      if (await this.delete(k)) count++;
    }
    return count;
  }

  public async clear(): Promise<void> {
    try {
      await this.db.prepare(`DELETE FROM "${this.tableName}";`).run();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new KVDockError(`failed to clear table: ${msg}`, "ERR_ADAPTER", { cause: err });
    }
  }

  public async keys(pattern?: string): Promise<string[]> {
    try {
      const res = await this.db
        .prepare(`SELECT key FROM "${this.tableName}";`)
        .all<{ key: string }>();

      const matched: string[] = [];
      const regex =
        pattern && pattern !== "*" ? new RegExp(`^${pattern.replace(/\*/g, ".*")}$`) : null;

      for (const row of res.results) {
        if (!regex || regex.test(row.key)) {
          const val = await this.get(row.key);
          if (val !== null) {
            matched.push(row.key);
          }
        }
      }
      return matched;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new KVDockError(`failed to list keys: ${msg}`, "ERR_ADAPTER", { cause: err });
    }
  }

  public async compareAndSwap<T = unknown>(
    key: string,
    expected: T | null,
    update: T,
    options?: SetOptions,
  ): Promise<boolean> {
    const current = await this.get<string>(key);
    const expStr = expected !== null ? String(expected) : null;

    if (current !== expStr) {
      return false;
    }

    await this.set(key, update, options);
    return true;
  }

  public async *scan(pattern?: string, _options?: ScanOptions): AsyncIterable<string> {
    const all = await this.keys(pattern);
    for (const k of all) {
      yield k;
    }
  }

  public async disconnect(): Promise<void> {
    // Cloudflare D1 does not require connection teardown
  }
}
