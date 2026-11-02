import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import type {
  AdapterCapabilities,
  ScanOptions,
  SetOptions,
  StorageAdapter,
} from "../../core/types.js";

function getNativeDatabaseSync(): typeof DatabaseSync {
  try {
    const req = createRequire(import.meta.url);
    const sqlite = req("node:sqlite") as { DatabaseSync: typeof DatabaseSync };
    return sqlite.DatabaseSync;
  } catch (err) {
    throw new Error(
      "node:sqlite is not available in this Node runtime. Pass a custom SQLite database via SQLiteAdapter({ db }) or use Node >= 22.11.0",
      { cause: err },
    );
  }
}

export interface SQLiteStatement {
  run(...params: unknown[]): { changes: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SQLiteDatabaseInterface {
  exec(sql: string): void;
  prepare(sql: string): SQLiteStatement;
  close?(): void;
}

export interface SQLiteAdapterOptions {
  path?: string;
  db?: SQLiteDatabaseInterface;
  tableName?: string;
  prefix?: string;
}

export class SQLiteAdapter implements StorageAdapter {
  public readonly name = "sqlite";
  public readonly capabilities: AdapterCapabilities = {
    ttl: true,
    batch: true,
    scan: true,
    cas: true,
    binary: false,
    stream: true,
  };

  private readonly db: SQLiteDatabaseInterface;
  private readonly tableName: string;
  private readonly prefix: string;
  private readonly ownsDb: boolean;

  private stmtGet!: SQLiteStatement;
  private stmtDel!: SQLiteStatement;
  private stmtUpsert!: SQLiteStatement;
  private stmtInsertNx!: SQLiteStatement;
  private stmtUpdateXx!: SQLiteStatement;
  private stmtAllKeys!: SQLiteStatement;

  constructor(options: SQLiteAdapterOptions = {}) {
    this.tableName = options.tableName ?? "kvdock";
    this.prefix = options.prefix ?? "";

    if (options.db) {
      this.db = options.db;
      this.ownsDb = false;
    } else {
      const NativeDb = getNativeDatabaseSync();
      this.db = new NativeDb(options.path ?? ":memory:");
      this.ownsDb = true;
    }

    this.init();
  }

  private init(): void {
    const table = this.tableName;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS "${table}" (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS "idx_${table}_expires_at" ON "${table}"(expires_at);
    `);

    this.stmtGet = this.db.prepare(`SELECT value, expires_at FROM "${table}" WHERE key = ?`);
    this.stmtDel = this.db.prepare(`DELETE FROM "${table}" WHERE key = ?`);
    this.stmtUpsert = this.db.prepare(
      `INSERT INTO "${table}" (key, value, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
    );
    this.stmtInsertNx = this.db.prepare(
      `INSERT OR IGNORE INTO "${table}" (key, value, expires_at) VALUES (?, ?, ?)`,
    );
    this.stmtUpdateXx = this.db.prepare(
      `UPDATE "${table}" SET value = ?, expires_at = ? WHERE key = ?`,
    );
    this.stmtAllKeys = this.db.prepare(`SELECT key, expires_at FROM "${table}"`);
  }

  private pkey(key: string): string {
    return this.prefix ? `${this.prefix}${key}` : key;
  }

  private unpkey(prefixed: string): string {
    if (this.prefix && prefixed.startsWith(this.prefix)) {
      return prefixed.slice(this.prefix.length);
    }
    return prefixed;
  }

  public async get<T = unknown>(key: string): Promise<T | null> {
    const k = this.pkey(key);
    const row = this.stmtGet.get(k) as { value: string; expires_at: number | null } | undefined;

    if (!row) return null;

    if (row.expires_at !== null && row.expires_at <= Date.now()) {
      this.stmtDel.run(k);
      return null;
    }

    return row.value as unknown as T;
  }

  public async set<T = unknown>(key: string, value: T, options?: SetOptions): Promise<void> {
    const k = this.pkey(key);
    const expiresAt = options?.ttl ? Date.now() + options.ttl : null;
    const strVal = String(value);

    if (options?.nx) {
      // Check existing validity (if expired, remove first)
      const existing = this.stmtGet.get(k) as { expires_at: number | null } | undefined;
      if (existing) {
        if (existing.expires_at !== null && existing.expires_at <= Date.now()) {
          this.stmtDel.run(k);
        } else {
          return;
        }
      }
      this.stmtInsertNx.run(k, strVal, expiresAt);
      return;
    }

    if (options?.xx) {
      const existing = await this.get(key);
      if (existing === null) return;
      this.stmtUpdateXx.run(strVal, expiresAt, k);
      return;
    }

    this.stmtUpsert.run(k, strVal, expiresAt);
  }

  public async delete(key: string): Promise<boolean> {
    const k = this.pkey(key);
    const res = this.stmtDel.run(k);
    return Number(res.changes) > 0;
  }

  public async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== null;
  }

  public async clear(): Promise<void> {
    if (this.prefix) {
      const keys = await this.keys();
      for (const k of keys) {
        await this.delete(k);
      }
    } else {
      this.db.exec(`DELETE FROM "${this.tableName}"`);
    }
  }

  public async keys(pattern?: string): Promise<string[]> {
    const rows = this.stmtAllKeys.all() as Array<{ key: string; expires_at: number | null }>;
    const now = Date.now();
    const result: string[] = [];

    for (const row of rows) {
      if (row.expires_at !== null && row.expires_at <= now) {
        this.stmtDel.run(row.key);
        continue;
      }
      if (this.prefix && !row.key.startsWith(this.prefix)) {
        continue;
      }
      const unprefixed = this.unpkey(row.key);
      result.push(unprefixed);
    }

    if (!pattern || pattern === "*") {
      return result;
    }

    const regex = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`);
    return result.filter((k) => regex.test(k));
  }

  public async *scan(pattern?: string, _options?: ScanOptions): AsyncIterable<string> {
    const all = await this.keys(pattern);
    for (const key of all) {
      yield key;
    }
  }

  public async getMany<T = unknown>(keys: string[]): Promise<Map<string, T | null>> {
    const res = new Map<string, T | null>();
    for (const key of keys) {
      res.set(key, await this.get<T>(key));
    }
    return res;
  }

  public async setMany<T = unknown>(
    entries: Array<{ key: string; value: T; options?: SetOptions }>,
  ): Promise<void> {
    if (entries.length === 0) return;
    this.db.exec("BEGIN TRANSACTION;");
    try {
      for (const entry of entries) {
        await this.set(entry.key, entry.value, entry.options);
      }
      this.db.exec("COMMIT;");
    } catch (err) {
      this.db.exec("ROLLBACK;");
      throw err;
    }
  }

  public async deleteMany(keys: string[]): Promise<number> {
    let deleted = 0;
    this.db.exec("BEGIN TRANSACTION;");
    try {
      for (const key of keys) {
        if (await this.delete(key)) deleted++;
      }
      this.db.exec("COMMIT;");
      return deleted;
    } catch (err) {
      this.db.exec("ROLLBACK;");
      throw err;
    }
  }

  public async compareAndSwap<T = unknown>(
    key: string,
    expected: T | null,
    update: T,
    options?: SetOptions,
  ): Promise<boolean> {
    this.db.exec("BEGIN TRANSACTION;");
    try {
      const current = await this.get<string>(key);
      const expectedStr = expected !== null ? String(expected) : null;

      if (current !== expectedStr) {
        this.db.exec("ROLLBACK;");
        return false;
      }

      await this.set(key, update, options);
      this.db.exec("COMMIT;");
      return true;
    } catch (err) {
      this.db.exec("ROLLBACK;");
      throw err;
    }
  }

  public async disconnect(): Promise<void> {
    if (this.ownsDb && typeof this.db.close === "function") {
      this.db.close();
    }
  }
}
