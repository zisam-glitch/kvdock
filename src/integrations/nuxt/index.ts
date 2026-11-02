import { MemoryAdapter } from "../../adapters/memory/index.js";
import type { StorageAdapter } from "../../core/types.js";

export interface NuxtDriverOptions {
  adapter?: StorageAdapter;
  base?: string;
  ttl?: number;
}

export interface UnstorageDriverLike {
  name: string;
  hasItem(key: string): Promise<boolean>;
  getItem<T = unknown>(key: string): Promise<T | null>;
  setItem<T = unknown>(key: string, value: T, opts?: { ttl?: number }): Promise<void>;
  removeItem(key: string): Promise<void>;
  getKeys(base?: string): Promise<string[]>;
  clear(base?: string): Promise<void>;
  dispose(): Promise<void>;
}

export function defineKVDockDriver(options: NuxtDriverOptions = {}): UnstorageDriverLike {
  const adapter = options.adapter ?? new MemoryAdapter();
  const basePrefix = options.base ? `${options.base}:` : "";
  const defaultTTL = options.ttl;

  const fullKey = (key: string): string => `${basePrefix}${key}`;

  return {
    name: "kvdock-nuxt-driver",
    async hasItem(key: string): Promise<boolean> {
      return adapter.has(fullKey(key));
    },
    async getItem<T = unknown>(key: string): Promise<T | null> {
      const raw = await adapter.get<string>(fullKey(key));
      if (raw === null || raw === undefined) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return raw as unknown as T;
      }
    },
    async setItem<T = unknown>(key: string, value: T, opts?: { ttl?: number }): Promise<void> {
      const ttl = opts?.ttl ?? defaultTTL;
      const serialized = typeof value === "string" ? value : JSON.stringify(value);
      await adapter.set(fullKey(key), serialized, ttl ? { ttl } : undefined);
    },
    async removeItem(key: string): Promise<void> {
      await adapter.delete(fullKey(key));
    },
    async getKeys(base?: string): Promise<string[]> {
      const pattern = base ? `${basePrefix}${base}*` : `${basePrefix}*`;
      const allKeys = await adapter.keys(pattern);
      return allKeys.map((k) => (k.startsWith(basePrefix) ? k.slice(basePrefix.length) : k));
    },
    async clear(base?: string): Promise<void> {
      const keys = await this.getKeys(base);
      for (const k of keys) {
        await adapter.delete(fullKey(k));
      }
    },
    async dispose(): Promise<void> {
      if (adapter.disconnect) {
        await adapter.disconnect();
      }
    },
  };
}

export const createNuxtStorageDriver = defineKVDockDriver;
