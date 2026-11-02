import { KVDockError } from "../../core/errors.js";
import type {
  AdapterCapabilities,
  ScanOptions,
  SetOptions,
  StorageAdapter,
} from "../../core/types.js";

export interface LibSQLClientLike {
  execute(
    stmt: { sql: string; args?: unknown[] } | string,
  ): Promise<{ rows: unknown[]; rowsAffected: number }>;
  close?(): void | Promise<void>;
}

export interface LibSQLAdapterOptions {
  client?: LibSQLClientLike;
  tableName?: string;
}

export class LibSQLAdapter implements StorageAdapter {
  public readonly name = "libsql";
  public readonly capabilities: AdapterCapabilities = {
    ttl: true,
    batch: true,
    scan: true,
    cas: true,
    binary: false,
    stream: false,
  };

  private readonly client: LibSQLClientLike;
  private readonly tableName: string;

  constructor(options: LibSQLAdapterOptions = {}) {
    this.tableName = options.tableName ?? "kvdock";

    if (options.client) {
      this.client = options.client;
    } else {
      // In-memory mock fallback when @libsql/client is not passed
      const mem = new Map<string, { value: string; expires_at: number | null }>();
      this.client = {
        async execute(stmt) {
          const sql = typeof stmt === "string" ? stmt : stmt.sql;
          const args = typeof stmt === "string" ? [] : (stmt.args ?? []);

          if (sql.includes("SELECT value, expires_at")) {
            const key = String(args[0]);
            const row = mem.get(key);
            if (!row) return { rows: [], rowsAffected: 0 };
            if (row.expires_at !== null && Date.now() > row.expires_at) {
              mem.delete(key);
              return { rows: [], rowsAffected: 0 };
            }
            return { rows: [row], rowsAffected: 0 };
          }
          if (sql.includes("INSERT OR REPLACE") || sql.includes("INSERT INTO")) {
            const [k, v, exp] = args;
            mem.set(String(k), {
              value: String(v),
              expires_at: (exp as number | null) ?? null,
            });
            return { rows: [], rowsAffected: 1 };
          }
          if (sql.includes("DELETE FROM") && args.length > 0) {
            const existed = mem.delete(String(args[0]));
            return { rows: [], rowsAffected: existed ? 1 : 0 };
          }
          if (sql.includes("DELETE FROM") && args.length === 0) {
            const count = mem.size;
            mem.clear();
            return { rows: [], rowsAffected: count };
          }
          if (sql.includes("SELECT key FROM")) {
            const now = Date.now();
            const validRows: Array<{ key: string }> = [];
            for (const [k, r] of mem.entries()) {
              if (r.expires_at === null || now <= r.expires_at) {
                validRows.push({ key: k });
              }
            }
            return { rows: validRows, rowsAffected: 0 };
          }
          return { rows: [], rowsAffected: 0 };
        },
      };
    }

    this.initTable().catch(() => {});
  }

  private async initTable(): Promise<void> {
    try {
      await this.client.execute(
        `CREATE TABLE IF NOT EXISTS "${this.tableName}" (key TEXT PRIMARY KEY, value TEXT, expires_at INTEGER);`,
      );
    } catch {
      // safe fallback
    }
  }

  public async get<T = unknown>(key: string): Promise<T | null> {
    try {
      const res = await this.client.execute({
        sql: `SELECT value, expires_at FROM "${this.tableName}" WHERE key = ?;`,
        args: [key],
      });
      const row = res.rows[0] as { value: string; expires_at: number | null } | undefined;
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
      await this.client.execute({
        sql: `INSERT OR REPLACE INTO "${this.tableName}" (key, value, expires_at) VALUES (?, ?, ?);`,
        args: [key, String(value), expiresAt],
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new KVDockError(`failed to set key "${key}": ${msg}`, "ERR_ADAPTER", { cause: err });
    }
  }

  public async delete(key: string): Promise<boolean> {
    const existing = await this.get(key);
    if (existing === null) return false;

    try {
      const res = await this.client.execute({
        sql: `DELETE FROM "${this.tableName}" WHERE key = ?;`,
        args: [key],
      });
      return res.rowsAffected > 0;
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
      await this.client.execute(`DELETE FROM "${this.tableName}";`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new KVDockError(`failed to clear table: ${msg}`, "ERR_ADAPTER", { cause: err });
    }
  }

  public async keys(pattern?: string): Promise<string[]> {
    try {
      const res = await this.client.execute(`SELECT key FROM "${this.tableName}";`);
      const rows = res.rows as Array<{ key: string }>;
      const valid: string[] = [];
      const regex =
        pattern && pattern !== "*" ? new RegExp(`^${pattern.replace(/\*/g, ".*")}$`) : null;

      for (const row of rows) {
        if (!regex || regex.test(row.key)) {
          const val = await this.get(row.key);
          if (val !== null) {
            valid.push(row.key);
          }
        }
      }
      return valid;
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
    if (this.client.close) {
      await this.client.close();
    }
  }
}
