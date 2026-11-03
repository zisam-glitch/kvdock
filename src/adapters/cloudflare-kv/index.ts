import type {
  AdapterCapabilities,
  ScanOptions,
  SetOptions,
  StorageAdapter,
} from "../../core/types.js";

export interface CloudflareKVNamespace {
  get(
    key: string,
    options?: { type?: "text" | "json" | "arrayBuffer" | "stream" },
  ): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: {
      expirationTtl?: number;
      expiration?: number;
      metadata?: Record<string, unknown>;
    },
  ): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: {
    prefix?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{
    keys: Array<{ name: string; expiration?: number; metadata?: unknown }>;
    list_complete: boolean;
    cursor?: string;
  }>;
}

export interface CloudflareKVAdapterOptions {
  kv: CloudflareKVNamespace;
  prefix?: string;
}

export class CloudflareKVAdapter implements StorageAdapter {
  public readonly name = "cloudflare-kv";
  public readonly capabilities: AdapterCapabilities = {
    ttl: true,
    batch: true,
    scan: true,
    cas: false,
    binary: false,
    stream: true,
  };

  private readonly kv: CloudflareKVNamespace;
  private readonly prefix: string;

  constructor(options: CloudflareKVAdapterOptions) {
    if (!options?.kv) {
      throw new Error("CloudflareKVAdapter requires a KVNamespace binding");
    }
    this.kv = options.kv;
    this.prefix = options.prefix ?? "";
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
    const raw = await this.kv.get(this.pkey(key), { type: "text" });
    if (raw === null || raw === undefined) return null;
    return raw as unknown as T;
  }

  public async set<T = unknown>(key: string, value: T, options?: SetOptions): Promise<void> {
    const k = this.pkey(key);

    if (options?.nx || options?.xx) {
      const exists = (await this.kv.get(k, { type: "text" })) !== null;
      if (options.nx && exists) return;
      if (options.xx && !exists) return;
    }

    const putOptions: { expirationTtl?: number } = {};

    if (options?.ttl && options.ttl > 0) {
      // Cloudflare KV requires minimum expirationTtl of 60 seconds
      const seconds = Math.ceil(options.ttl / 1000);
      putOptions.expirationTtl = Math.max(60, seconds);
    }

    await this.kv.put(k, String(value), putOptions);
  }

  public async delete(key: string): Promise<boolean> {
    const k = this.pkey(key);
    const exists = (await this.kv.get(k, { type: "text" })) !== null;
    if (!exists) return false;
    await this.kv.delete(k);
    return true;
  }

  public async has(key: string): Promise<boolean> {
    const val = await this.kv.get(this.pkey(key), { type: "text" });
    return val !== null;
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
    const allKeys = await this.keys();
    for (const key of allKeys) {
      await this.delete(key);
    }
  }

  public async keys(pattern?: string): Promise<string[]> {
    const searchPrefix = this.prefix;
    const collected: string[] = [];
    let cursor: string | undefined;

    do {
      const page = await this.kv.list({
        prefix: searchPrefix || undefined,
        cursor,
      });

      for (const item of page.keys) {
        collected.push(this.unpkey(item.name));
      }

      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);

    if (!pattern || pattern === "*") {
      return collected;
    }

    const regex = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`);
    return collected.filter((k) => regex.test(k));
  }

  public async *scan(pattern?: string, _options?: ScanOptions): AsyncIterable<string> {
    const all = await this.keys(pattern);
    for (const key of all) {
      yield key;
    }
  }
}
