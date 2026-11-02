export interface SetOptions {
  ttl?: number;
  nx?: boolean;
  xx?: boolean;
  tags?: string[];
}

export interface ScanOptions {
  batchSize?: number;
}

export interface AdapterCapabilities {
  ttl: boolean;
  batch: boolean;
  scan: boolean;
  cas: boolean;
  binary: boolean;
  stream?: boolean;
}

export interface KVEntry<T = unknown> {
  key: string;
  value: T;
  expiresAt?: number | null;
  updatedAt: number;
  tags?: string[];
}

export interface Serializer {
  serialize(value: unknown): string;
  deserialize<T = unknown>(raw: string): T;
}

export interface StorageAdapter {
  readonly name: string;
  readonly capabilities: AdapterCapabilities;

  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T, options?: SetOptions): Promise<void>;
  delete(key: string): Promise<boolean>;
  has(key: string): Promise<boolean>;
  clear(): Promise<void>;
  keys(pattern?: string): Promise<string[]>;

  // Optional extensions
  getMany?<T = unknown>(keys: string[]): Promise<Map<string, T | null>>;
  setMany?<T = unknown>(
    entries: Array<{ key: string; value: T; options?: SetOptions }>,
  ): Promise<void>;
  deleteMany?(keys: string[]): Promise<number>;
  compareAndSwap?<T = unknown>(
    key: string,
    expected: T | null,
    update: T,
    options?: SetOptions,
  ): Promise<boolean>;
  scan?(pattern?: string, options?: ScanOptions): AsyncIterable<string>;

  disconnect?(): Promise<void>;
}

export type KVDockLogLevel = "debug" | "info" | "warn" | "error";

export type KVDockLogger = (
  level: KVDockLogLevel,
  message: string,
  meta?: Record<string, unknown>,
) => void;

export type KVDockEventType =
  | "hit"
  | "miss"
  | "set"
  | "delete"
  | "clear"
  | "cas"
  | "stampede_coalesced";

export interface KVDockEvent {
  type: KVDockEventType;
  key?: string;
  timestamp: number;
  meta?: Record<string, unknown>;
}

export interface StoreOptions {
  adapter: StorageAdapter;
  prefix?: string;
  defaultTTL?: number;
  serializer?: Serializer;
  logger?: KVDockLogger;
  onEvent?: (event: KVDockEvent) => void;
}

export interface StoreMetrics {
  hits: number;
  misses: number;
  sets: number;
  deletes: number;
  casSuccess: number;
  casFailure: number;
  stampedeCoalesced: number;
}
