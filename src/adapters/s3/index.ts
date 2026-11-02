import type { AdapterCapabilities, SetOptions, StorageAdapter } from "../../core/types.js";

export interface S3ClientInterface {
  getObject(params: { Bucket: string; Key: string }): Promise<{
    Body: string | Uint8Array | AsyncIterable<Uint8Array>;
    Metadata?: Record<string, string>;
  } | null>;
  putObject(params: {
    Bucket: string;
    Key: string;
    Body: string | Uint8Array;
    Metadata?: Record<string, string>;
  }): Promise<unknown>;
  deleteObject(params: { Bucket: string; Key: string }): Promise<unknown>;
  deleteObjects?(params: {
    Bucket: string;
    Delete: { Objects: Array<{ Key: string }> };
  }): Promise<{ Deleted?: Array<{ Key: string }> }>;
  headObject?(params: { Bucket: string; Key: string }): Promise<{
    Metadata?: Record<string, string>;
  } | null>;
  listObjectsV2?(params: { Bucket: string; Prefix?: string }): Promise<{
    Contents?: Array<{ Key?: string }>;
  }>;
}

export interface S3AdapterOptions {
  client: S3ClientInterface;
  bucket: string;
  prefix?: string;
}

export class S3Adapter implements StorageAdapter {
  public readonly name = "s3";
  public readonly capabilities: AdapterCapabilities = {
    ttl: true,
    batch: true,
    scan: true,
    cas: false,
    binary: true,
    stream: true,
  };

  private readonly client: S3ClientInterface;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(options: S3AdapterOptions) {
    if (!options.client || !options.bucket) {
      throw new Error("S3Adapter requires both client and bucket configuration");
    }
    this.client = options.client;
    this.bucket = options.bucket;
    this.prefix = options.prefix ?? "";
  }

  private resolveKey(key: string): string {
    return this.prefix ? `${this.prefix}${key}` : key;
  }

  private stripPrefix(objectKey: string): string {
    if (this.prefix && objectKey.startsWith(this.prefix)) {
      return objectKey.slice(this.prefix.length);
    }
    return objectKey;
  }

  private async bodyToString(
    body: string | Uint8Array | AsyncIterable<Uint8Array>,
  ): Promise<string> {
    if (typeof body === "string") return body;
    if (body instanceof Uint8Array) {
      return new TextDecoder().decode(body);
    }

    const chunks: Uint8Array[] = [];
    for await (const chunk of body) {
      chunks.push(chunk);
    }
    const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.length;
    }
    return new TextDecoder().decode(merged);
  }

  public async get<T = unknown>(key: string): Promise<T | null> {
    const s3Key = this.resolveKey(key);
    try {
      const res = await this.client.getObject({
        Bucket: this.bucket,
        Key: s3Key,
      });

      if (!res || !res.Body) return null;

      // Check TTL in metadata
      if (res.Metadata?.expiresat) {
        const expiresAt = Number.parseInt(res.Metadata.expiresat, 10);
        if (!Number.isNaN(expiresAt) && expiresAt <= Date.now()) {
          await this.delete(key).catch(() => {});
          return null;
        }
      }

      const raw = await this.bodyToString(res.Body);
      try {
        return JSON.parse(raw) as T;
      } catch {
        return raw as unknown as T;
      }
    } catch {
      return null;
    }
  }

  public async set<T = unknown>(key: string, value: T, options?: SetOptions): Promise<void> {
    const s3Key = this.resolveKey(key);

    if (options?.nx) {
      const exists = await this.has(key);
      if (exists) return;
    } else if (options?.xx) {
      const exists = await this.has(key);
      if (!exists) return;
    }

    const metadata: Record<string, string> = {};
    if (options?.ttl && options.ttl > 0) {
      metadata.expiresat = String(Date.now() + options.ttl);
    }

    const body = typeof value === "string" ? value : JSON.stringify(value);

    await this.client.putObject({
      Bucket: this.bucket,
      Key: s3Key,
      Body: body,
      Metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    });
  }

  public async delete(key: string): Promise<boolean> {
    const s3Key = this.resolveKey(key);
    try {
      await this.client.deleteObject({
        Bucket: this.bucket,
        Key: s3Key,
      });
      return true;
    } catch {
      return false;
    }
  }

  public async has(key: string): Promise<boolean> {
    const s3Key = this.resolveKey(key);
    if (this.client.headObject) {
      try {
        const head = await this.client.headObject({
          Bucket: this.bucket,
          Key: s3Key,
        });
        if (!head) return false;
        if (head.Metadata?.expiresat) {
          const expiresAt = Number.parseInt(head.Metadata.expiresat, 10);
          if (!Number.isNaN(expiresAt) && expiresAt <= Date.now()) {
            await this.delete(key).catch(() => {});
            return false;
          }
        }
        return true;
      } catch {
        return false;
      }
    }

    return (await this.get(key)) !== null;
  }

  public async clear(): Promise<void> {
    const keys = await this.keys();
    if (keys.length > 0) {
      await this.deleteMany(keys);
    }
  }

  public async keys(pattern?: string): Promise<string[]> {
    if (!this.client.listObjectsV2) return [];

    const res = await this.client.listObjectsV2({
      Bucket: this.bucket,
      Prefix: this.prefix || undefined,
    });

    const items = res.Contents ?? [];
    const matchedKeys: string[] = [];

    for (const item of items) {
      if (!item.Key) continue;
      const key = this.stripPrefix(item.Key);
      matchedKeys.push(key);
    }

    if (!pattern || pattern === "*") return matchedKeys;
    const regex = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`);
    return matchedKeys.filter((k) => regex.test(k));
  }

  public async getMany<T = unknown>(keys: string[]): Promise<Map<string, T | null>> {
    const map = new Map<string, T | null>();
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

    if (this.client.deleteObjects) {
      const s3Keys = keys.map((k) => ({ Key: this.resolveKey(k) }));
      const res = await this.client.deleteObjects({
        Bucket: this.bucket,
        Delete: { Objects: s3Keys },
      });
      return res.Deleted?.length ?? 0;
    }

    let count = 0;
    await Promise.all(
      keys.map(async (k) => {
        if (await this.delete(k)) count++;
      }),
    );
    return count;
  }
}
