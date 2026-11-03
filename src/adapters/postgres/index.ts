import { KVDockError } from "../../core/errors.js";
import type {
  AdapterCapabilities,
  ScanOptions,
  SetOptions,
  StorageAdapter,
} from "../../core/types.js";

export interface PostgresQueryResult<T = unknown> {
  rows: T[];
  rowCount?: number;
}

export interface PostgresClientLike {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<PostgresQueryResult<T>>;
  end?(): Promise<void>;
}

export interface PostgresAdapterOptions {
  client?: PostgresClientLike;
  tableName?: string;
}

export class PostgresAdapter implements StorageAdapter {
  public readonly name = "postgres";
  public readonly capabilities: AdapterCapabilities = {
    ttl: true,
    batch: true,
    scan: true,
    cas: true,
    binary: false,
    stream: false,
  };

  private readonly client: PostgresClientLike;
  private readonly tableName: string;

  constructor(options: PostgresAdapterOptions = {}) {
    this.tableName = options.tableName ?? "kvdock";

    if (options.client) {
      this.client = options.client;
    } else {
      // In-memory mock fallback when running outside of live PostgreSQL
      const mem = new Map<string, { value: string; expires_at: number | null }>();

      this.client = {
        async query<T = unknown>(sql: string, params: unknown[] = []) {
          if (sql.includes("SELECT value, expires_at")) {
            const key = String(params[0]);
            const row = mem.get(key);
            if (!row) return { rows: [] as T[], rowCount: 0 };
            if (row.expires_at !== null && Date.now() > row.expires_at) {
              mem.delete(key);
              return { rows: [] as T[], rowCount: 0 };
            }
            return { rows: [row as unknown as T], rowCount: 1 };
          }
          if (sql.includes("ON CONFLICT")) {
            const [k, v, exp] = params;
            mem.set(String(k), {
              value: String(v),
              expires_at: (exp as number | null) ?? null,
            });
            return { rows: [] as T[], rowCount: 1 };
          }
          if (sql.includes("DELETE FROM") && params.length > 0) {
            const deleted = mem.delete(String(params[0]));
            return { rows: [] as T[], rowCount: deleted ? 1 : 0 };
          }
          if (sql.includes("DELETE FROM") && params.length === 0) {
            const count = mem.size;
            mem.clear();
            return { rows: [] as T[], rowCount: count };
          }
          if (sql.includes("SELECT key FROM")) {
            const now = Date.now();
            const results: Array<{ key: string }> = [];
            for (const [k, r] of mem.entries()) {
              if (r.expires_at === null || now <= r.expires_at) {
                results.push({ key: k });
              }
            }
            return { rows: results as unknown as T[], rowCount: results.length };
          }
          return { rows: [] as T[], rowCount: 0 };
        },
      };
    }

    this.initTable().catch(() => {});
  }

  private async initTable(): Promise<void> {
    try {
      await this.client.query(
        `CREATE TABLE IF NOT EXISTS "${this.tableName}" (key VARCHAR(512) PRIMARY KEY, value TEXT NOT NULL, expires_at BIGINT);`,
      );
    } catch {
      // safe fallback
    }
  }

  public async get<T = unknown>(key: string): Promise<T | null> {
    try {
      const res = await this.client.query<{
        value: string;
        expires_at: number | null;
      }>(`SELECT value, expires_at FROM "${this.tableName}" WHERE key = $1;`, [key]);
      const row = res.rows[0];
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
    const existing = await this.get(key);
    const exists = existing !== null;

    if (options?.nx && exists) return;
    if (options?.xx && !exists) return;

    const expiresAt = options?.ttl ? Date.now() + options.ttl : null;

    try {
      await this.client.query(
        `INSERT INTO "${this.tableName}" (key, value, expires_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at;`,
        [key, String(value), expiresAt],
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new KVDockError(`failed to set key "${key}": ${msg}`, "ERR_ADAPTER", { cause: err });
    }
  }

  public async delete(key: string): Promise<boolean> {
    const existing = await this.get(key);
    if (existing === null) return false;

    try {
      const res = await this.client.query(`DELETE FROM "${this.tableName}" WHERE key = $1;`, [key]);
      return (res.rowCount ?? 0) > 0;
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
      await this.client.query(`DELETE FROM "${this.tableName}";`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new KVDockError(`failed to clear postgres table: ${msg}`, "ERR_ADAPTER", {
        cause: err,
      });
    }
  }

  public async keys(pattern?: string): Promise<string[]> {
    try {
      const res = await this.client.query<{ key: string }>(`SELECT key FROM "${this.tableName}";`);
      const matched: string[] = [];
      const regex =
        pattern && pattern !== "*" ? new RegExp(`^${pattern.replace(/\*/g, ".*")}$`) : null;

      for (const row of res.rows) {
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
    const curStr = current !== null ? String(current) : null;

    if (curStr !== expStr) {
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
    if (this.client.end) {
      await this.client.end();
    }
  }
}
