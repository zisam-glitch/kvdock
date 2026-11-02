import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  AdapterCapabilities,
  ScanOptions,
  SetOptions,
  StorageAdapter,
} from "../../core/types.js";

export interface FsAdapterOptions {
  dir?: string;
}

interface StoredPayload {
  value: string;
  expiresAt: number | null;
}

export class FsAdapter implements StorageAdapter {
  public readonly name = "fs";
  public readonly capabilities: AdapterCapabilities = {
    ttl: true,
    batch: false,
    scan: true,
    cas: false,
    binary: false,
    stream: true,
  };

  private readonly baseDir: string;
  private initialized = false;

  constructor(options: FsAdapterOptions = {}) {
    this.baseDir = options.dir ?? join(process.cwd(), ".kvdock");
  }

  private async ensureInit(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.baseDir, { recursive: true });
    this.initialized = true;
  }

  // hash or encode key to safe filename
  private keyToPath(key: string): string {
    const encoded = Buffer.from(key).toString("base64url");
    const shard = encoded.slice(0, 2);
    return join(this.baseDir, shard, `${encoded}.json`);
  }

  private pathToKey(filepath: string): string {
    const filename = filepath.split("/").pop() ?? "";
    const b64 = filename.replace(/\.json$/, "");
    return Buffer.from(b64, "base64url").toString("utf-8");
  }

  public async get<T = unknown>(key: string): Promise<T | null> {
    await this.ensureInit();
    const filepath = this.keyToPath(key);

    try {
      const raw = await readFile(filepath, "utf-8");
      const parsed: StoredPayload = JSON.parse(raw);

      if (parsed.expiresAt !== null && parsed.expiresAt <= Date.now()) {
        await unlink(filepath).catch(() => {});
        return null;
      }

      return parsed.value as unknown as T;
    } catch {
      return null;
    }
  }

  public async set<T = unknown>(key: string, value: T, options?: SetOptions): Promise<void> {
    await this.ensureInit();
    const filepath = this.keyToPath(key);

    if (options?.nx || options?.xx) {
      const exists = await stat(filepath)
        .then(() => true)
        .catch(() => false);
      if (options.nx && exists) return;
      if (options.xx && !exists) return;
    }

    await mkdir(dirname(filepath), { recursive: true });

    const payload: StoredPayload = {
      value: String(value),
      expiresAt: options?.ttl ? Date.now() + options.ttl : null,
    };

    // atomic write to temp file then rename
    const tmpPath = `${filepath}.${randomUUID()}.tmp`;
    await writeFile(tmpPath, JSON.stringify(payload), "utf-8");
    await rename(tmpPath, filepath);
  }

  public async delete(key: string): Promise<boolean> {
    await this.ensureInit();
    const filepath = this.keyToPath(key);
    try {
      await unlink(filepath);
      return true;
    } catch {
      return false;
    }
  }

  public async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== null;
  }

  public async clear(): Promise<void> {
    await rm(this.baseDir, { recursive: true, force: true });
    this.initialized = false;
    await this.ensureInit();
  }

  public async keys(pattern?: string): Promise<string[]> {
    await this.ensureInit();
    const matchedKeys: string[] = [];

    const readDirRecursive = async (dir: string) => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await readDirRecursive(full);
        } else if (entry.name.endsWith(".json")) {
          const key = this.pathToKey(full);
          // verify expiry before yielding key
          const val = await this.get(key);
          if (val !== null) {
            matchedKeys.push(key);
          }
        }
      }
    };

    await readDirRecursive(this.baseDir);

    if (!pattern || pattern === "*") return matchedKeys;
    const regex = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`);
    return matchedKeys.filter((k) => regex.test(k));
  }

  public async *scan(pattern?: string, _options?: ScanOptions): AsyncIterable<string> {
    const all = await this.keys(pattern);
    for (const key of all) {
      yield key;
    }
  }
}
