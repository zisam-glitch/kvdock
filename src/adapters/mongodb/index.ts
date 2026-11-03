import type { AdapterCapabilities, SetOptions, StorageAdapter } from "../../core/types.js";

export interface MongoDocument<T = unknown> {
  _id: string;
  value: T;
  expiresAt?: Date | null;
}

export interface MongoCollectionLike<T = unknown> {
  createIndex(
    indexSpec: Record<string, number>,
    options?: { expireAfterSeconds?: number; background?: boolean },
  ): Promise<string>;
  findOne(filter: Record<string, unknown>): Promise<MongoDocument<T> | null>;
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { upsert?: boolean },
  ): Promise<{
    acknowledged: boolean;
    matchedCount: number;
    modifiedCount: number;
    upsertedCount: number;
  }>;
  deleteOne(
    filter: Record<string, unknown>,
  ): Promise<{ acknowledged: boolean; deletedCount: number }>;
  deleteMany(
    filter: Record<string, unknown>,
  ): Promise<{ acknowledged: boolean; deletedCount: number }>;
  find(
    filter?: Record<string, unknown>,
    options?: { projection?: Record<string, number> },
  ): {
    toArray(): Promise<MongoDocument<T>[]>;
  };
  findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { returnDocument?: "before" | "after"; upsert?: boolean },
  ): Promise<MongoDocument<T> | null>;
}

export interface MongoDBAdapterOptions<T = unknown> {
  collection?: MongoCollectionLike<T>;
  ensureIndex?: boolean;
}

/**
 * In-memory fallback mock of MongoCollectionLike for zero-dependency test runner.
 */
export class MockMongoCollection<T = unknown> implements MongoCollectionLike<T> {
  private readonly docs = new Map<string, MongoDocument<T>>();

  private isExpired(doc: MongoDocument<T>): boolean {
    return Boolean(doc.expiresAt && doc.expiresAt.getTime() <= Date.now());
  }

  public async createIndex(): Promise<string> {
    return "expiresAt_1";
  }

  public async findOne(filter: Record<string, unknown>): Promise<MongoDocument<T> | null> {
    const id = filter._id as string | undefined;
    if (id !== undefined) {
      const doc = this.docs.get(id);
      if (!doc || this.isExpired(doc)) {
        if (doc) this.docs.delete(id);
        return null;
      }
      return { ...doc };
    }

    for (const [key, doc] of this.docs.entries()) {
      if (this.isExpired(doc)) {
        this.docs.delete(key);
        continue;
      }
      return { ...doc };
    }
    return null;
  }

  public async updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { upsert?: boolean },
  ): Promise<{
    acknowledged: boolean;
    matchedCount: number;
    modifiedCount: number;
    upsertedCount: number;
  }> {
    const id = filter._id as string;
    const doc = this.docs.get(id);
    const setFields = (update.$set as Partial<MongoDocument<T>>) ?? {};

    if (!doc || this.isExpired(doc)) {
      if (doc) this.docs.delete(id);
      if (options?.upsert) {
        const newDoc: MongoDocument<T> = {
          _id: id,
          value: setFields.value as T,
          expiresAt: setFields.expiresAt ?? null,
        };
        this.docs.set(id, newDoc);
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
      }
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    }

    if (setFields.value !== undefined) doc.value = setFields.value as T;
    if (setFields.expiresAt !== undefined) doc.expiresAt = setFields.expiresAt;
    this.docs.set(id, doc);
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
  }

  public async deleteOne(
    filter: Record<string, unknown>,
  ): Promise<{ acknowledged: boolean; deletedCount: number }> {
    const id = filter._id as string;
    const exists = this.docs.has(id);
    this.docs.delete(id);
    return { acknowledged: true, deletedCount: exists ? 1 : 0 };
  }

  public async deleteMany(
    filter: Record<string, unknown>,
  ): Promise<{ acknowledged: boolean; deletedCount: number }> {
    const inList = (filter._id as { $in?: string[] } | undefined)?.$in;
    if (inList) {
      let count = 0;
      for (const id of inList) {
        if (this.docs.delete(id)) count++;
      }
      return { acknowledged: true, deletedCount: count };
    }

    const count = this.docs.size;
    this.docs.clear();
    return { acknowledged: true, deletedCount: count };
  }

  public find(filter?: Record<string, unknown>): { toArray(): Promise<MongoDocument<T>[]> } {
    return {
      toArray: async () => {
        const list: MongoDocument<T>[] = [];
        const inList = (filter?._id as { $in?: string[] } | undefined)?.$in;
        const inSet = inList ? new Set(inList) : null;

        for (const [key, doc] of this.docs.entries()) {
          if (this.isExpired(doc)) {
            this.docs.delete(key);
            continue;
          }
          if (!inSet || inSet.has(doc._id)) {
            list.push({ ...doc });
          }
        }
        return list;
      },
    };
  }

  public async findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { returnDocument?: "before" | "after"; upsert?: boolean },
  ): Promise<MongoDocument<T> | null> {
    const id = filter._id as string;
    const doc = this.docs.get(id);
    const expectedValue = filter.value;
    const setFields = (update.$set as Partial<MongoDocument<T>>) ?? {};

    if (!doc || this.isExpired(doc)) {
      if (doc) this.docs.delete(id);
      if (options?.upsert && expectedValue === undefined) {
        const newDoc: MongoDocument<T> = {
          _id: id,
          value: setFields.value as T,
          expiresAt: setFields.expiresAt ?? null,
        };
        this.docs.set(id, newDoc);
        return options.returnDocument === "after" ? { ...newDoc } : null;
      }
      return null;
    }

    if (expectedValue !== undefined) {
      const match =
        typeof expectedValue === "object"
          ? JSON.stringify(doc.value) === JSON.stringify(expectedValue)
          : doc.value === expectedValue;
      if (!match) return null;
    }

    const before = { ...doc };
    if (setFields.value !== undefined) doc.value = setFields.value as T;
    if (setFields.expiresAt !== undefined) doc.expiresAt = setFields.expiresAt;
    this.docs.set(id, doc);

    return options?.returnDocument === "after" ? { ...doc } : before;
  }
}

/**
 * MongoDB collection storage adapter featuring automatic Background TTL index expiration.
 */
export class MongoDBAdapter implements StorageAdapter {
  public readonly name = "mongodb";
  public readonly capabilities: AdapterCapabilities = {
    ttl: true,
    batch: true,
    scan: true,
    cas: true,
    binary: false,
    stream: false,
  };

  private readonly collection: MongoCollectionLike;

  public constructor(options: MongoDBAdapterOptions = {}) {
    this.collection = options.collection ?? new MockMongoCollection();

    if (options.ensureIndex !== false) {
      this.collection
        .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, background: true })
        .catch(() => {});
    }
  }

  public async get<T = unknown>(key: string): Promise<T | null> {
    const doc = await this.collection.findOne({
      _id: key,
    });
    if (!doc) return null;
    return doc.value as T;
  }

  public async set<T = unknown>(key: string, value: T, options?: SetOptions): Promise<void> {
    const expiresAt = options?.ttl ? new Date(Date.now() + options.ttl) : null;

    if (options?.nx) {
      const existing = await this.collection.findOne({ _id: key });
      if (existing) return;
    }

    if (options?.xx) {
      const existing = await this.collection.findOne({ _id: key });
      if (!existing) return;
    }

    await this.collection.updateOne(
      { _id: key },
      { $set: { value, expiresAt } },
      { upsert: !options?.xx },
    );
  }

  public async delete(key: string): Promise<boolean> {
    const res = await this.collection.deleteOne({ _id: key });
    return res.deletedCount > 0;
  }

  public async has(key: string): Promise<boolean> {
    const doc = await this.collection.findOne({ _id: key });
    return doc !== null;
  }

  public async clear(): Promise<void> {
    await this.collection.deleteMany({});
  }

  public async keys(pattern?: string): Promise<string[]> {
    const docs = await this.collection.find({}).toArray();
    const allKeys = docs.map((d) => d._id);

    if (!pattern || pattern === "*") {
      return allKeys;
    }

    const regex = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`);
    return allKeys.filter((k) => regex.test(k));
  }

  public async *scan(pattern?: string): AsyncIterable<string> {
    const allKeys = await this.keys(pattern);
    for (const key of allKeys) {
      yield key;
    }
  }

  public async getMany<T = unknown>(keys: string[]): Promise<Map<string, T | null>> {
    const map = new Map<string, T | null>();
    for (const k of keys) {
      map.set(k, null);
    }

    const docs = await this.collection.find({ _id: { $in: keys } }).toArray();
    for (const doc of docs) {
      map.set(doc._id, doc.value as T);
    }
    return map;
  }

  public async setMany<T = unknown>(
    entries: { key: string; value: T; options?: SetOptions }[],
  ): Promise<void> {
    for (const entry of entries) {
      await this.set(entry.key, entry.value, entry.options);
    }
  }

  public async deleteMany(keys: string[]): Promise<number> {
    const res = await this.collection.deleteMany({ _id: { $in: keys } });
    return res.deletedCount;
  }

  public async compareAndSwap<T = unknown>(
    key: string,
    expected: T | null,
    desired: T,
    options?: SetOptions,
  ): Promise<boolean> {
    const expiresAt = options?.ttl ? new Date(Date.now() + options.ttl) : null;

    if (expected === null) {
      // Upsert only if doc doesn't exist
      const existing = await this.collection.findOne({ _id: key });
      if (existing) return false;

      const res = await this.collection.findOneAndUpdate(
        { _id: key },
        { $set: { value: desired, expiresAt } },
        { upsert: true, returnDocument: "after" },
      );
      return res !== null;
    }

    const res = await this.collection.findOneAndUpdate(
      { _id: key, value: expected },
      { $set: { value: desired, expiresAt } },
      { returnDocument: "after" },
    );

    return res !== null;
  }

  public async ttl(key: string): Promise<number | null> {
    const doc = await this.collection.findOne({ _id: key });
    if (!doc || !doc.expiresAt) return null;
    const diff = doc.expiresAt.getTime() - Date.now();
    return diff > 0 ? diff : 0;
  }
}

export { MongoDBAdapter as MongoAdapter };
