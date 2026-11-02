import type {
  AdapterCapabilities,
  ScanOptions,
  SetOptions,
  StorageAdapter,
} from "../../core/types.js";

export interface IndexedDBAdapterOptions {
  dbName?: string;
  storeName?: string;
  prefix?: string;
  factory?: IDBFactory;
}

interface IDBRecord {
  key: string;
  value: string;
  expiresAt: number | null;
}

export class IndexedDBAdapter implements StorageAdapter {
  public readonly name = "indexeddb";
  public readonly capabilities: AdapterCapabilities = {
    ttl: true,
    batch: true,
    scan: true,
    cas: true,
    binary: false,
    stream: true,
  };

  private readonly dbName: string;
  private readonly storeName: string;
  private readonly prefix: string;
  private readonly factory: IDBFactory;
  private dbPromise?: Promise<IDBDatabase>;

  constructor(options: IndexedDBAdapterOptions = {}) {
    this.dbName = options.dbName ?? "kvdock_db";
    this.storeName = options.storeName ?? "kvdock_store";
    this.prefix = options.prefix ?? "";
    this.factory =
      options.factory ?? (typeof indexedDB !== "undefined" ? indexedDB : ({} as IDBFactory));
  }

  private async getDB(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.factory.open(this.dbName, 1);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: "key" });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    return this.dbPromise;
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
    const db = await this.getDB();
    const k = this.pkey(key);

    return new Promise<T | null>((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readonly");
      const store = tx.objectStore(this.storeName);
      const req = store.get(k);

      req.onsuccess = () => {
        const record = req.result as IDBRecord | undefined;
        if (!record) {
          resolve(null);
          return;
        }

        if (record.expiresAt !== null && record.expiresAt <= Date.now()) {
          resolve(null);
          return;
        }

        resolve(record.value as unknown as T);
      };
      req.onerror = () => reject(req.error);
    });
  }

  public async set<T = unknown>(key: string, value: T, options?: SetOptions): Promise<void> {
    const db = await this.getDB();
    const k = this.pkey(key);
    const expiresAt = options?.ttl ? Date.now() + options.ttl : null;

    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);

      if (options?.nx || options?.xx) {
        const getReq = store.get(k);
        getReq.onsuccess = () => {
          const rec = getReq.result as IDBRecord | undefined;
          const exists = Boolean(rec && (rec.expiresAt === null || rec.expiresAt > Date.now()));
          if (options.nx && exists) {
            resolve();
            return;
          }
          if (options.xx && !exists) {
            resolve();
            return;
          }
          const putReq = store.put({ key: k, value: String(value), expiresAt });
          putReq.onsuccess = () => resolve();
          putReq.onerror = () => reject(putReq.error);
        };
        getReq.onerror = () => reject(getReq.error);
        return;
      }

      const putReq = store.put({ key: k, value: String(value), expiresAt });
      putReq.onsuccess = () => resolve();
      putReq.onerror = () => reject(putReq.error);
    });
  }

  public async delete(key: string): Promise<boolean> {
    const db = await this.getDB();
    const k = this.pkey(key);

    return new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);
      const getReq = store.get(k);

      getReq.onsuccess = () => {
        if (!getReq.result) {
          resolve(false);
          return;
        }
        const delReq = store.delete(k);
        delReq.onsuccess = () => resolve(true);
        delReq.onerror = () => reject(delReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  public async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== null;
  }

  public async clear(): Promise<void> {
    const db = await this.getDB();

    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);
      const req = store.clear();

      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  public async keys(pattern?: string): Promise<string[]> {
    const db = await this.getDB();

    const allKeys = await new Promise<string[]>((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readonly");
      const store = tx.objectStore(this.storeName);
      const req = store.getAll();

      req.onsuccess = () => {
        const records = (req.result as IDBRecord[]) || [];
        const now = Date.now();
        const valid: string[] = [];

        for (const rec of records) {
          if (rec.expiresAt !== null && rec.expiresAt <= now) {
            continue;
          }
          if (this.prefix && !rec.key.startsWith(this.prefix)) {
            continue;
          }
          valid.push(this.unpkey(rec.key));
        }
        resolve(valid);
      };
      req.onerror = () => reject(req.error);
    });

    if (!pattern || pattern === "*") {
      return allKeys;
    }

    const regex = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`);
    return allKeys.filter((k) => regex.test(k));
  }

  public async *scan(pattern?: string, _options?: ScanOptions): AsyncIterable<string> {
    const all = await this.keys(pattern);
    for (const key of all) {
      yield key;
    }
  }

  public async getMany<T = unknown>(keys: string[]): Promise<Map<string, T | null>> {
    const map = new Map<string, T | null>();
    for (const k of keys) {
      map.set(k, await this.get<T>(k));
    }
    return map;
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

  public async compareAndSwap<T = unknown>(
    key: string,
    expected: T | null,
    update: T,
    options?: SetOptions,
  ): Promise<boolean> {
    const current = await this.get<string>(key);
    const expectedStr = expected !== null ? String(expected) : null;

    if (current !== expectedStr) {
      return false;
    }

    await this.set(key, update, options);
    return true;
  }

  public async disconnect(): Promise<void> {
    if (this.dbPromise) {
      const db = await this.dbPromise;
      db.close();
      this.dbPromise = undefined;
    }
  }
}
