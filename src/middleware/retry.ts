import { KVDockError } from "../core/errors.js";
import type { ScanOptions, SetOptions, StorageAdapter } from "../core/types.js";

export type JitterStrategy = "full" | "equal" | "decorrelated" | "none";

export interface BackoffOptions {
  /**
   * Initial backoff delay in milliseconds.
   * @default 100
   */
  readonly initialDelayMs?: number;

  /**
   * Maximum backoff delay cap in milliseconds.
   * @default 5000
   */
  readonly maxDelayMs?: number;

  /**
   * Multiplier applied on each retry attempt.
   * @default 2
   */
  readonly backoffFactor?: number;

  /**
   * Jitter strategy to prevent thundering herd spikes.
   * - "full": uniform random between 0 and exponential delay (AWS recommended)
   * - "equal": half fixed delay, half random delay
   * - "decorrelated": decorrelated random jitter based on previous delay
   * - "none": deterministic exponential delay without randomization
   * - true: defaults to "full"
   * - false: defaults to "none"
   * @default "full"
   */
  readonly jitter?: JitterStrategy | boolean;

  /**
   * Custom pseudo-random generator returning a float in [0, 1).
   * Useful for deterministic testing.
   * @default Math.random
   */
  readonly randomFn?: () => number;
}

export interface RetryAttemptInfo {
  readonly attempt: number;
  readonly maxRetries: number;
  readonly delayMs: number;
  readonly error: unknown;
  readonly operation?: string;
  readonly key?: string;
}

export interface RetryOptions extends BackoffOptions {
  /**
   * Maximum number of retry attempts before giving up.
   * E.g. maxRetries = 3 means 1 initial call + up to 3 retries (4 total attempts).
   * @default 3
   */
  readonly maxRetries?: number;

  /**
   * Predicate determining whether a given failure should be retried.
   * By default, retries transient connection resets, timeouts, rate limits (429), and 5xx errors.
   */
  readonly isRetryable?: (error: unknown, attempt: number) => boolean;

  /**
   * Callback fired immediately before sleeping and retrying.
   */
  readonly onRetry?: (info: RetryAttemptInfo) => void;

  /**
   * AbortSignal to cancel waiting retries immediately.
   */
  readonly signal?: AbortSignal;

  /**
   * Custom sleep implementation.
   * @default defaultSleep
   */
  readonly sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export type AdapterOperationName =
  | "get"
  | "set"
  | "delete"
  | "has"
  | "clear"
  | "keys"
  | "getMany"
  | "setMany"
  | "deleteMany"
  | "compareAndSwap"
  | "scan"
  | "disconnect";

export interface AdapterRetryOptions extends RetryOptions {
  /**
   * Explicit list of storage adapter operations to wrap with retry logic.
   * If omitted, all supported adapter operations are retried.
   */
  readonly operations?: readonly AdapterOperationName[];

  /**
   * When true, only idempotent operations (get, has, keys, delete, getMany, deleteMany, clear)
   * are retried. Mutating operations (set, setMany, compareAndSwap) fail fast on first error.
   * @default false
   */
  readonly idempotentOnly?: boolean;
}

export class RetryExhaustedError extends KVDockError {
  public readonly attempts: number;
  public readonly lastError: unknown;
  public readonly totalDelayMs: number;
  public readonly operation?: string;
  public readonly key?: string;

  constructor(options: {
    message?: string;
    attempts: number;
    lastError: unknown;
    totalDelayMs: number;
    operation?: string;
    key?: string;
  }) {
    const errMessage =
      options.lastError instanceof Error
        ? options.lastError.message
        : String(options.lastError ?? "Unknown error");
    const opInfo = options.operation
      ? ` during "${options.operation}"${options.key ? ` (key: ${options.key})` : ""}`
      : "";
    const message =
      options.message ??
      `Retry exhausted after ${options.attempts} attempt${options.attempts === 1 ? "" : "s"}${opInfo}: ${errMessage}`;

    super(message, "ERR_ADAPTER", {
      cause: options.lastError instanceof Error ? options.lastError : undefined,
    });
    this.name = "RetryExhaustedError";
    this.attempts = options.attempts;
    this.lastError = options.lastError;
    this.totalDelayMs = options.totalDelayMs;
    this.operation = options.operation;
    this.key = options.key;
  }
}

const RETRYABLE_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EPIPE",
  "ENOTFOUND",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ERR_CONNECTION",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export function isRetryableError(error: unknown): boolean {
  if (!error) return false;

  // Explicit user flag
  if (typeof error === "object" && error !== null) {
    if ("retryable" in error && typeof (error as { retryable: unknown }).retryable === "boolean") {
      return (error as { retryable: boolean }).retryable;
    }
  }

  // Non-retryable core errors
  if (error instanceof Error) {
    if (
      error.name === "TTLValidationError" ||
      error.name === "SerializationError" ||
      error.name === "AbortError"
    ) {
      return false;
    }
  }

  // System error codes
  const code = (error as { code?: string })?.code;
  if (typeof code === "string" && RETRYABLE_CODES.has(code)) {
    return true;
  }

  // HTTP status codes
  const status =
    (error as { status?: number; statusCode?: number })?.status ??
    (error as { status?: number; statusCode?: number })?.statusCode;
  if (typeof status === "number" && RETRYABLE_HTTP_STATUSES.has(status)) {
    return true;
  }

  if (error instanceof Error) {
    const name = error.name.toLowerCase();
    if (name.includes("connection") || name.includes("timeout") || name.includes("network")) {
      return true;
    }

    const message = error.message.toLowerCase();
    if (
      message.includes("econnreset") ||
      message.includes("econnrefused") ||
      message.includes("etimedout") ||
      message.includes("timed out") ||
      message.includes("timeout") ||
      message.includes("socket hang up") ||
      message.includes("connection reset") ||
      message.includes("connection refused") ||
      message.includes("too many requests") ||
      message.includes("rate limit") ||
      message.includes("service unavailable") ||
      message.includes("network error") ||
      message.includes("temporarily unavailable")
    ) {
      return true;
    }
  }

  return false;
}

export function calculateBackoffDelay(
  attempt: number,
  options: BackoffOptions = {},
  previousDelayMs?: number,
): number {
  const initialDelayMs = Math.max(0, options.initialDelayMs ?? 100);
  const maxDelayMs = Math.max(initialDelayMs, options.maxDelayMs ?? 5000);
  const backoffFactor = Math.max(1, options.backoffFactor ?? 2);
  const randomFn = options.randomFn ?? Math.random;

  // Resolve jitter strategy
  let strategy: JitterStrategy = "full";
  if (options.jitter === false || options.jitter === "none") {
    strategy = "none";
  } else if (options.jitter === true || options.jitter === "full" || options.jitter === undefined) {
    strategy = "full";
  } else {
    strategy = options.jitter;
  }

  const effectiveAttempt = Math.max(1, attempt);
  const rawDelay = Math.min(maxDelayMs, initialDelayMs * backoffFactor ** (effectiveAttempt - 1));

  const rand = Math.max(0, Math.min(1, randomFn()));

  let calculated: number;
  switch (strategy) {
    case "none": {
      calculated = rawDelay;
      break;
    }
    case "equal": {
      const half = Math.floor(rawDelay / 2);
      calculated = half + Math.round(rand * half);
      break;
    }
    case "decorrelated": {
      const prev =
        previousDelayMs !== undefined ? Math.max(initialDelayMs, previousDelayMs) : initialDelayMs;
      const ceiling = Math.min(maxDelayMs, Math.max(initialDelayMs, prev * 3));
      const range = ceiling - initialDelayMs;
      calculated = range > 0 ? initialDelayMs + Math.round(rand * range) : initialDelayMs;
      break;
    }
    default: {
      calculated = Math.round(rand * rawDelay);
      break;
    }
  }

  return Math.min(maxDelayMs, Math.max(0, Math.floor(calculated)));
}

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new Error("Operation aborted"));
  }
  if (ms <= 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      reject(signal?.reason ?? new Error("Operation aborted"));
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      (timer as { unref(): void }).unref();
    }
  });
}

export async function retry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
  context?: { operation?: string; key?: string },
): Promise<T> {
  const maxRetries = Math.max(0, options.maxRetries ?? 3);
  const isRetryable = options.isRetryable ?? isRetryableError;
  const sleepFn = options.sleepFn ?? defaultSleep;
  const signal = options.signal;

  let totalDelayMs = 0;
  let previousDelayMs: number | undefined;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (signal?.aborted) {
      throw signal.reason ?? new Error("Operation aborted");
    }

    try {
      return await operation(attempt);
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason ?? new Error("Operation aborted");
      }

      const retriesAttempted = attempt - 1;
      const hasRetriesLeft = retriesAttempted < maxRetries;
      const retryable = isRetryable(error, attempt);

      if (!hasRetriesLeft || !retryable) {
        if (!retryable) {
          throw error;
        }
        throw new RetryExhaustedError({
          attempts: attempt,
          lastError: error,
          totalDelayMs,
          operation: context?.operation,
          key: context?.key,
        });
      }

      const delayMs = calculateBackoffDelay(attempt, options, previousDelayMs);
      previousDelayMs = delayMs;
      totalDelayMs += delayMs;

      if (options.onRetry) {
        options.onRetry({
          attempt,
          maxRetries,
          delayMs,
          error,
          operation: context?.operation,
          key: context?.key,
        });
      }

      await sleepFn(delayMs, signal);
    }
  }

  throw new Error("Retry loop ended unexpectedly");
}

const IDEMPOTENT_OPERATIONS = new Set<AdapterOperationName>([
  "get",
  "has",
  "keys",
  "delete",
  "getMany",
  "deleteMany",
  "clear",
]);

export function withRetry(
  adapter: StorageAdapter,
  options: AdapterRetryOptions = {},
): StorageAdapter {
  const allowedOps = options.operations ? new Set(options.operations) : null;
  const shouldRetryOp = (op: AdapterOperationName): boolean => {
    if (allowedOps && !allowedOps.has(op)) return false;
    if (options.idempotentOnly && !IDEMPOTENT_OPERATIONS.has(op)) return false;
    return true;
  };

  const executeWithRetry = <T>(
    op: AdapterOperationName,
    key: string | undefined,
    fn: () => Promise<T>,
  ): Promise<T> => {
    if (!shouldRetryOp(op)) {
      return fn();
    }
    return retry(() => fn(), options, { operation: op, key });
  };

  const name = adapter.name.includes("retry") ? adapter.name : `${adapter.name}:retry`;

  const wrapped: StorageAdapter = {
    name,
    capabilities: { ...adapter.capabilities },

    get<T = unknown>(key: string): Promise<T | null> {
      return executeWithRetry("get", key, () => adapter.get<T>(key));
    },

    set<T = unknown>(key: string, value: T, setOptions?: SetOptions): Promise<void> {
      return executeWithRetry("set", key, () => adapter.set<T>(key, value, setOptions));
    },

    delete(key: string): Promise<boolean> {
      return executeWithRetry("delete", key, () => adapter.delete(key));
    },

    has(key: string): Promise<boolean> {
      return executeWithRetry("has", key, () => adapter.has(key));
    },

    clear(): Promise<void> {
      return executeWithRetry("clear", undefined, () => adapter.clear());
    },

    keys(pattern?: string): Promise<string[]> {
      return executeWithRetry("keys", pattern, () => adapter.keys(pattern));
    },
  };

  const origGetMany = adapter.getMany?.bind(adapter);
  if (origGetMany) {
    wrapped.getMany = <T = unknown>(keys: string[]): Promise<Map<string, T | null>> => {
      return executeWithRetry("getMany", keys.join(","), () => origGetMany<T>(keys));
    };
  }

  const origSetMany = adapter.setMany?.bind(adapter);
  if (origSetMany) {
    wrapped.setMany = <T = unknown>(
      entries: Array<{ key: string; value: T; options?: SetOptions }>,
    ): Promise<void> => {
      const keys = entries.map((e) => e.key).join(",");
      return executeWithRetry("setMany", keys, () => origSetMany<T>(entries));
    };
  }

  const origDeleteMany = adapter.deleteMany?.bind(adapter);
  if (origDeleteMany) {
    wrapped.deleteMany = (keys: string[]): Promise<number> => {
      return executeWithRetry("deleteMany", keys.join(","), () => origDeleteMany(keys));
    };
  }

  const origCas = adapter.compareAndSwap?.bind(adapter);
  if (origCas) {
    wrapped.compareAndSwap = <T = unknown>(
      key: string,
      expected: T | null,
      update: T,
      setOptions?: SetOptions,
    ): Promise<boolean> => {
      return executeWithRetry("compareAndSwap", key, () =>
        origCas<T>(key, expected, update, setOptions),
      );
    };
  }

  const origScan = adapter.scan?.bind(adapter);
  if (origScan) {
    wrapped.scan = (pattern?: string, scanOptions?: ScanOptions): AsyncIterable<string> => {
      return origScan(pattern, scanOptions);
    };
  }

  const origDisconnect = adapter.disconnect?.bind(adapter);
  if (origDisconnect) {
    wrapped.disconnect = (): Promise<void> => {
      return executeWithRetry("disconnect", undefined, () => origDisconnect());
    };
  }

  return wrapped;
}

export const wrapWithRetry = withRetry;

export class RetryMiddleware {
  private readonly options: AdapterRetryOptions;

  constructor(options: AdapterRetryOptions = {}) {
    this.options = options;
  }

  public wrap(adapter: StorageAdapter, overrideOptions?: AdapterRetryOptions): StorageAdapter {
    return withRetry(adapter, { ...this.options, ...overrideOptions });
  }

  public async execute<T>(
    operation: (attempt: number) => Promise<T>,
    overrideOptions?: RetryOptions,
    context?: { operation?: string; key?: string },
  ): Promise<T> {
    return retry(operation, { ...this.options, ...overrideOptions }, context);
  }
}
