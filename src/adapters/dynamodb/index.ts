import type {
  AdapterCapabilities,
  ScanOptions,
  SetOptions,
  StorageAdapter,
} from "../../core/types.js";

export interface DynamoDBClientInterface {
  get(params: { TableName: string; Key: Record<string, unknown> }): Promise<{
    Item?: Record<string, unknown>;
  }>;
  put(params: {
    TableName: string;
    Item: Record<string, unknown>;
    ConditionExpression?: string;
  }): Promise<unknown>;
  delete(params: { TableName: string; Key: Record<string, unknown> }): Promise<unknown>;
  batchGet?(params: {
    RequestItems: Record<string, { Keys: Array<Record<string, unknown>> }>;
  }): Promise<{ Responses?: Record<string, Array<Record<string, unknown>>> }>;
  batchWrite?(params: {
    RequestItems: Record<
      string,
      Array<{
        DeleteRequest?: { Key: Record<string, unknown> };
        PutRequest?: { Item: Record<string, unknown> };
      }>
    >;
  }): Promise<unknown>;
  scan?(params: {
    TableName: string;
    ProjectionExpression?: string;
    FilterExpression?: string;
  }): Promise<{ Items?: Array<Record<string, unknown>> }>;
}

export interface DynamoDBAdapterOptions {
  client: DynamoDBClientInterface;
  tableName: string;
  partitionKey?: string;
  prefix?: string;
  ttlAttribute?: string;
}

export class DynamoDBAdapter implements StorageAdapter {
  public readonly name = "dynamodb";
  public readonly capabilities: AdapterCapabilities = {
    ttl: true,
    batch: true,
    scan: true,
    cas: false,
    binary: false,
    stream: true,
  };

  private readonly client: DynamoDBClientInterface;
  private readonly tableName: string;
  private readonly partitionKey: string;
  private readonly prefix: string;
  private readonly ttlAttribute: string;

  constructor(options: DynamoDBAdapterOptions) {
    if (!options.client || !options.tableName) {
      throw new Error("DynamoDBAdapter requires both client and tableName options");
    }
    this.client = options.client;
    this.tableName = options.tableName;
    this.partitionKey = options.partitionKey ?? "pk";
    this.prefix = options.prefix ?? "";
    this.ttlAttribute = options.ttlAttribute ?? "ttl";
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

  private makeKey(key: string): Record<string, unknown> {
    return { [this.partitionKey]: this.resolveKey(key) };
  }

  private isExpired(item: Record<string, unknown>): boolean {
    const rawTtl = item[this.ttlAttribute];
    if (typeof rawTtl === "number") {
      // DynamoDB TTL is in epoch seconds
      return rawTtl <= Math.floor(Date.now() / 1000);
    }
    return false;
  }

  public async get<T = unknown>(key: string): Promise<T | null> {
    try {
      const res = await this.client.get({
        TableName: this.tableName,
        Key: this.makeKey(key),
      });

      if (!res.Item) return null;

      if (this.isExpired(res.Item)) {
        await this.delete(key).catch(() => {});
        return null;
      }

      const val = res.Item.value;
      if (val === undefined || val === null) return null;

      if (typeof val === "string") {
        try {
          return JSON.parse(val) as T;
        } catch {
          return val as unknown as T;
        }
      }

      return val as T;
    } catch {
      return null;
    }
  }

  public async set<T = unknown>(key: string, value: T, options?: SetOptions): Promise<void> {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    const item: Record<string, unknown> = {
      [this.partitionKey]: this.resolveKey(key),
      value: serialized,
      rawKey: key,
    };

    if (options?.ttl && options.ttl > 0) {
      item[this.ttlAttribute] = Math.floor((Date.now() + options.ttl) / 1000);
    }

    let conditionExpression: string | undefined;
    if (options?.nx) {
      conditionExpression = `attribute_not_exists(${this.partitionKey})`;
    } else if (options?.xx) {
      conditionExpression = `attribute_exists(${this.partitionKey})`;
    }

    try {
      await this.client.put({
        TableName: this.tableName,
        Item: item,
        ConditionExpression: conditionExpression,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("ConditionalCheckFailed") || msg.includes("TransactionCanceled")) {
        // NX/XX condition wasn't met, silently ignore per StorageAdapter spec
        return;
      }
      throw err;
    }
  }

  public async delete(key: string): Promise<boolean> {
    try {
      await this.client.delete({
        TableName: this.tableName,
        Key: this.makeKey(key),
      });
      return true;
    } catch {
      return false;
    }
  }

  public async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== null;
  }

  public async clear(): Promise<void> {
    const allKeys = await this.keys();
    if (allKeys.length > 0) {
      await this.deleteMany(allKeys);
    }
  }

  public async keys(pattern?: string): Promise<string[]> {
    if (!this.client.scan) return [];

    try {
      const res = await this.client.scan({
        TableName: this.tableName,
        ProjectionExpression: `${this.partitionKey}, ${this.ttlAttribute}`,
      });

      const matched: string[] = [];
      const nowSeconds = Math.floor(Date.now() / 1000);

      for (const item of res.Items ?? []) {
        const pk = String(item[this.partitionKey] ?? "");
        const ttl = item[this.ttlAttribute];
        if (typeof ttl === "number" && ttl <= nowSeconds) {
          continue;
        }

        const raw = this.stripPrefix(pk);
        matched.push(raw);
      }

      if (!pattern || pattern === "*") return matched;
      const regex = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`);
      return matched.filter((k) => regex.test(k));
    } catch {
      return [];
    }
  }

  public async getMany<T = unknown>(keys: string[]): Promise<Map<string, T | null>> {
    const map = new Map<string, T | null>();
    if (keys.length === 0) return map;

    if (this.client.batchGet) {
      try {
        const requestKeys = keys.map((k) => this.makeKey(k));
        const res = await this.client.batchGet({
          RequestItems: {
            [this.tableName]: {
              Keys: requestKeys,
            },
          },
        });

        const items = res.Responses?.[this.tableName] ?? [];
        const itemMap = new Map<string, Record<string, unknown>>();
        for (const item of items) {
          const pk = String(item[this.partitionKey] ?? "");
          itemMap.set(this.stripPrefix(pk), item);
        }

        for (const k of keys) {
          const found = itemMap.get(k);
          if (!found || this.isExpired(found)) {
            map.set(k, null);
          } else {
            const raw = found.value;
            if (typeof raw === "string") {
              try {
                map.set(k, JSON.parse(raw) as T);
              } catch {
                map.set(k, raw as unknown as T);
              }
            } else {
              map.set(k, raw as T);
            }
          }
        }
        return map;
      } catch {
        // Fall back to parallel gets
      }
    }

    await Promise.all(
      keys.map(async (k) => {
        map.set(k, await this.get<T>(k));
      }),
    );
    return map;
  }

  public async setMany<T = unknown>(
    entries: Array<{ key: string; value: T; options?: SetOptions }>,
  ): Promise<void> {
    await Promise.all(entries.map((e) => this.set(e.key, e.value, e.options)));
  }

  public async deleteMany(keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;

    if (this.client.batchWrite) {
      try {
        const deleteRequests = keys.map((k) => ({
          DeleteRequest: { Key: this.makeKey(k) },
        }));
        await this.client.batchWrite({
          RequestItems: {
            [this.tableName]: deleteRequests,
          },
        });
        return keys.length;
      } catch {
        // Fall back to parallel deletes
      }
    }

    let count = 0;
    await Promise.all(
      keys.map(async (k) => {
        if (await this.delete(k)) count++;
      }),
    );
    return count;
  }

  public async *scan(pattern?: string, _options?: ScanOptions): AsyncIterable<string> {
    const all = await this.keys(pattern);
    for (const key of all) {
      yield key;
    }
  }
}
