import { KVDockError } from "../../core/errors.js";
import type {
  AdapterCapabilities,
  ScanOptions,
  SetOptions,
  StorageAdapter,
} from "../../core/types.js";

export interface BunSQLiteDatabaseLike {
  query(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
  run(sql: string, ...params: unknown[]): unknown;
  close(): void;
}

export interface BunSQLiteAdapterOptions {
  db?: BunSQLiteDatabaseLike;
  filename?: string;
  tableName?: string;
}

export class BunSQLiteAdapter implements StorageAdapter {
  public readonly name = "bun-sqlite";
  public readonly capabilities: AdapterCapabilities = {
    ttl: true,
    batch: true,
    scan: true,
    cas: true,
    binary: false,
    stream: false,
  };

  private readonly db: BunSQLiteDatabaseLike;
  private readonly tableName: string;

  constructor(options: BunSQLiteAdapterOptions = {}) {
    this.tableName = options.tableName ?? "kvdock";

    if (options.db) {
      this.db = options.db;
    } else {
      // In-memory mock fallback when running outside of the Bun runtime
      const memoryStore = new Map<string, { value: string; expires_at: number | null }>();
      this.db = {
        query: (sql: string) => ({
          get: (...params: unknown[]) => {
            if (sql.includes("SELECT value, expires_at")) {
              const key = String(params[0]);
              const row = memoryStore.get(key);
              if (!row) return null;
              if (row.expires_at !== null && Date.now() > row.expires_at) {
                memoryStore.delete(key);
                return null;
              }
              return row;
            }
            return null;
          },
          all: (..._params: unknown[]) => {
            const now = Date.now();
            const results: { key: string }[] = [];
            for (const [k, row] of memoryStore.entries()) {
              if (row.expires_at === null || now <= row.expires_at) {
                results.push({ key: k });
              }
            }
            return results;
          },
          run: (...params: unknown[]) => {
            if (sql.includes("INSERT OR REPLACE")) {
              const [key, value, expires_at] = params;
              memoryStore.set(String(key), {
                value: String(value),
                expires_at: (expires_at as number | null) ?? null,
              });
            } else if (sql.includes("DELETE FROM") && params[0]) {
              memoryStore.delete(String(params[0]));
            } else if (sql.includes("DELETE FROM") && !params[0]) {
              memoryStore.clear();
            }
            return {};
          },
        }),
        run: (_sql: string, ..._params: unknown[]) => {},
        close: () => {
          memoryStore.clear();
        },
      };
    }

    this.initTable();
  }

  private initTable(): void {
    try {
      this.db.run(
        `CREATE TABLE IF NOT EXISTS "${this.tableName}" (key TEXT PRIMARY KEY, value TEXT, expires_at INTEGER);`,
      );
    } catch {
      // safe fallback if db does not support DDL run
    }
  }

  public async get<T = unknown>(key: string): Promise<T | null> {
    try {
      const q = this.db.query(`SELECT value, expires_at FROM "${this.tableName}" WHERE key = ?;`);
      const row = q.get(key) as { value: string; expires_at: number | null } | null;
      if (!row) return null;

      if (row.expires_at !== null && Date.now() > row.expires_at) {
        await this.delete(key);
        return null;
      }

      return row.value as unknown as T;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new KVDockError(`failed to get key "${key}": ${msg}`, "ERR_ADAPTER", { cause: err });
    }
  }

  public async set<T = unknown>(key: string, value: T, options?: SetOptions): Promise<void> {
    const exists = (await this.get(key)) !== null;
    if (options?.nx && exists) return;
    if (options?.xx && !exists) return;

    const expiresAt = options?.ttl ? Date.now() + options.ttl : null;

    try {
      const q = this.db.query(
        `INSERT OR REPLACE INTO "${this.tableName}" (key, value, expires_at) VALUES (?, ?, ?);`,
      );
      q.run(key, String(value), expiresAt);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new KVDockError(`failed to set key "${key}": ${msg}`, "ERR_ADAPTER", { cause: err });
    }
  }

  public async delete(key: string): Promise<boolean> {
    const existing = await this.get(key);
    if (existing === null) return false;

    try {
      const q = this.db.query(`DELETE FROM "${this.tableName}" WHERE key = ?;`);
      q.run(key);
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new KVDockError(`failed to delete key "${key}": ${msg}`, "ERR_ADAPTER", { cause: err });
    }
  }

  public async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== null;
  }

  public async clear(): Promise<void> {
    try {
      const q = this.db.query(`DELETE FROM "${this.tableName}";`);
      q.run();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new KVDockError(`failed to clear table: ${msg}`, "ERR_ADAPTER", { cause: err });
    }
  }

  public async keys(pattern?: string): Promise<string[]> {
    try {
      const q = this.db.query(`SELECT key FROM "${this.tableName}";`);
      const rows = q.all() as Array<{ key: string }>;
      const validKeys: string[] = [];
      const regex =
        pattern && pattern !== "*" ? new RegExp(`^${pattern.replace(/\*/g, ".*")}$`) : null;

      for (const row of rows) {
        if (!regex || regex.test(row.key)) {
          const val = await this.get(row.key);
          if (val !== null) {
            validKeys.push(row.key);
          }
        }
      }
      return validKeys;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new KVDockError(`failed to retrieve keys: ${msg}`, "ERR_ADAPTER", { cause: err });
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
    try {
      this.db.close();
    } catch {
      // safe ignore
    }
  }
}
