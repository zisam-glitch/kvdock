export interface SetOptions {
  readonly ttl?: number;
  readonly nx?: boolean;
  readonly xx?: boolean;
  readonly tags?: readonly string[];
  readonly timeoutMs?: number;
}

export interface ScanOptions {
  readonly batchSize?: number;
}

export interface AdapterCapabilities {
  readonly ttl: boolean;
  readonly batch: boolean;
  readonly scan: boolean;
  readonly cas: boolean;
  readonly binary: boolean;
  readonly stream?: boolean;
}

export interface KVEntry<T = unknown> {
  readonly key: string;
  readonly value: T;
  readonly expiresAt?: number | null;
  readonly updatedAt: number;
  readonly tags?: readonly string[];
}

export interface ValueCodec<TDecoded = unknown, TEncoded = string> {
  encode(value: TDecoded): TEncoded;
  decode(raw: TEncoded): TDecoded;
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
  readonly type: KVDockEventType;
  readonly key?: string;
  readonly timestamp: number;
  readonly meta?: Record<string, unknown>;
}

export interface StoreOptions {
  readonly adapter: StorageAdapter;
  readonly prefix?: string;
  readonly defaultTTL?: number;
  readonly serializer?: Serializer;
  readonly codec?: ValueCodec<unknown, string>;
  readonly logger?: KVDockLogger;
  readonly onEvent?: (event: KVDockEvent) => void;
  readonly timeoutMs?: number;
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
