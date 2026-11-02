import type {
  AdapterCapabilities,
  ScanOptions,
  SetOptions,
  StorageAdapter,
} from "../../core/types.js";

export interface UpstashAdapterOptions {
  url: string;
  token: string;
  prefix?: string;
  fetch?: typeof fetch;
}

interface UpstashCommandResponse<T = unknown> {
  result?: T;
  error?: string;
}

export class UpstashAdapter implements StorageAdapter {
  public readonly name = "upstash";
  public readonly capabilities: AdapterCapabilities = {
    ttl: true,
    batch: true,
    scan: true,
    cas: false,
    binary: false,
    stream: true,
  };

  private readonly url: string;
  private readonly token: string;
  private readonly prefix: string;
  private readonly customFetch: typeof fetch;

  constructor(options: UpstashAdapterOptions) {
    if (!options.url || !options.token) {
      throw new Error("UpstashAdapter requires both url and token");
    }
    this.url = options.url.replace(/\/+$/, "");
    this.token = options.token;
    this.prefix = options.prefix ?? "";
    this.customFetch = options.fetch ?? globalThis.fetch;
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

  private async execute<T = unknown>(command: Array<string | number>): Promise<T> {
    const res = await this.customFetch(this.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
    });

    if (!res.ok) {
      throw new Error(`Upstash request failed with status ${res.status}: ${res.statusText}`);
    }

    const data = (await res.json()) as UpstashCommandResponse<T>;
    if (data.error) {
      throw new Error(`Upstash command error: ${data.error}`);
    }
    return data.result as T;
  }

  private async pipeline<T = unknown>(commands: Array<Array<string | number>>): Promise<T[]> {
    if (commands.length === 0) return [];
    const res = await this.customFetch(`${this.url}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(commands),
    });

    if (!res.ok) {
      throw new Error(`Upstash pipeline failed with status ${res.status}: ${res.statusText}`);
    }

    const data = (await res.json()) as Array<UpstashCommandResponse<T>>;
    return data.map((item) => {
      if (item.error) {
        throw new Error(`Upstash pipeline command error: ${item.error}`);
      }
      return item.result as T;
    });
  }

  public async get<T = unknown>(key: string): Promise<T | null> {
    const raw = await this.execute<string | null>(["GET", this.pkey(key)]);
    if (raw === null || raw === undefined) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return raw as unknown as T;
    }
  }

  public async set<T = unknown>(key: string, value: T, options?: SetOptions): Promise<void> {
    const serialized = JSON.stringify(value);
    const cmd: Array<string | number> = ["SET", this.pkey(key), serialized];

    if (options?.ttl && options.ttl > 0) {
      cmd.push("PX", options.ttl);
    }

    if (options?.nx) {
      cmd.push("NX");
    } else if (options?.xx) {
      cmd.push("XX");
    }

    await this.execute(cmd);
  }

  public async delete(key: string): Promise<boolean> {
    const deleted = await this.execute<number>(["DEL", this.pkey(key)]);
    return deleted > 0;
  }

  public async has(key: string): Promise<boolean> {
    const exists = await this.execute<number>(["EXISTS", this.pkey(key)]);
    return exists > 0;
  }

  public async clear(): Promise<void> {
    if (this.prefix) {
      const keys = await this.keys();
      if (keys.length > 0) {
        await this.deleteMany(keys);
      }
    } else {
      await this.execute(["FLUSHDB"]);
    }
  }

  public async keys(pattern = "*"): Promise<string[]> {
    const searchPattern = this.prefix ? `${this.prefix}${pattern}` : pattern;
    const rawKeys = await this.execute<string[]>(["KEYS", searchPattern]);
    if (!Array.isArray(rawKeys)) return [];
    return rawKeys.map((k) => this.unpkey(k));
  }

  public async *scan(pattern = "*", _options?: ScanOptions): AsyncIterable<string> {
    const all = await this.keys(pattern);
    for (const key of all) {
      yield key;
    }
  }

  public async getMany<T = unknown>(keys: string[]): Promise<Map<string, T | null>> {
    const map = new Map<string, T | null>();
    if (keys.length === 0) return map;

    const commands = keys.map((k) => ["GET", this.pkey(k)]);
    const results = await this.pipeline<string | null>(commands);

    for (let i = 0; i < keys.length; i++) {
      const raw = results[i];
      if (raw === null || raw === undefined) {
        map.set(keys[i], null);
      } else {
        try {
          map.set(keys[i], JSON.parse(raw) as T);
        } catch {
          map.set(keys[i], raw as unknown as T);
        }
      }
    }

    return map;
  }

  public async setMany<T = unknown>(
    entries: Array<{ key: string; value: T; options?: SetOptions }>,
  ): Promise<void> {
    if (entries.length === 0) return;

    const commands: Array<Array<string | number>> = entries.map((e) => {
      const cmd: Array<string | number> = ["SET", this.pkey(e.key), JSON.stringify(e.value)];
      if (e.options?.ttl && e.options.ttl > 0) {
        cmd.push("PX", e.options.ttl);
      }
      if (e.options?.nx) {
        cmd.push("NX");
      } else if (e.options?.xx) {
        cmd.push("XX");
      }
      return cmd;
    });

    await this.pipeline(commands);
  }

  public async deleteMany(keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    const prefixed = keys.map((k) => this.pkey(k));
    return await this.execute<number>(["DEL", ...prefixed]);
  }
}
