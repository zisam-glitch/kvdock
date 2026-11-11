import { CircuitBreakerOpenError } from "../core/errors.js";
import type { ScanOptions, SetOptions, StorageAdapter } from "../core/types.js";

export type CircuitBreakerState = "closed" | "open" | "half_open";

export interface CircuitBreakerSnapshot {
  readonly state: CircuitBreakerState;
  readonly totalCalls: number;
  readonly successfulCalls: number;
  readonly failedCalls: number;
  readonly slowCalls: number;
  readonly rejectedCalls: number;
  readonly failureRate: number;
  readonly slowCallRate: number;
  readonly consecutiveFailures: number;
  readonly consecutiveSuccesses: number;
  readonly lastFailureTimestamp?: number;
  readonly lastStateChangeTimestamp: number;
  readonly timeRemainingUntilResetMs: number;
}

export interface CircuitBreakerOptions {
  /**
   * Number of consecutive failures or failure rate (if 0 < threshold <= 1 with slidingWindowSize)
   * that trips the circuit breaker from CLOSED to OPEN.
   * @default 5
   */
  readonly failureThreshold?: number;

  /**
   * Time in milliseconds the circuit breaker stays OPEN before entering HALF_OPEN to probe recovery.
   * @default 10000 (10 seconds)
   */
  readonly resetTimeoutMs?: number;

  /**
   * Exponential multiplier applied to resetTimeoutMs when probe fails and re-trips.
   * @default 1 (no backoff)
   */
  readonly resetTimeoutBackoffFactor?: number;

  /**
   * Maximum reset timeout cap in milliseconds when backoff is enabled.
   * @default 60000
   */
  readonly maxResetTimeoutMs?: number;

  /**
   * Number of probe requests allowed through in HALF_OPEN state.
   * @default 1
   */
  readonly halfOpenMaxProbes?: number;

  /**
   * Number of consecutive successful probe requests in HALF_OPEN needed to close the circuit.
   * @default 2
   */
  readonly consecutiveSuccessesNeeded?: number;

  /**
   * Duration threshold in milliseconds for slow call detection. Calls exceeding this are flagged.
   */
  readonly slowCallThresholdMs?: number;

  /**
   * Slow call rate threshold (0 to 1) within the sliding window that triggers circuit trip.
   * E.g., 0.5 means 50% slow calls will trip the breaker.
   */
  readonly slowCallRateThreshold?: number;

  /**
   * Size of the sliding window for tracking call outcomes (success / failure / slow).
   * @default 20
   */
  readonly slidingWindowSize?: number;

  /**
   * Minimum number of calls in the sliding window before rate calculations trigger tripping.
   * @default 5
   */
  readonly minimumNumberOfCalls?: number;

  /**
   * Custom predicate to determine whether an error should count towards failure.
   * @default (err) => true
   */
  readonly isFailure?: (error: unknown) => boolean;

  /**
   * Secondary fallback adapter to route operations to when the circuit is OPEN or failing.
   */
  readonly fallbackAdapter?: StorageAdapter;

  /**
   * When true, if the circuit is OPEN (or fails) and no fallbackAdapter is configured,
   * safe default values are returned instead of throwing CircuitBreakerOpenError
   * (e.g., get -> null, has -> false, set -> void).
   * @default false
   */
  readonly degradeGracefully?: boolean;

  /**
   * Callback invoked when circuit breaker state changes.
   */
  readonly onStateChange?: (
    from: CircuitBreakerState,
    to: CircuitBreakerState,
    snapshot: CircuitBreakerSnapshot,
  ) => void;

  /**
   * Callback invoked when the circuit trips from CLOSED/HALF_OPEN to OPEN.
   */
  readonly onTrip?: (error: unknown, snapshot: CircuitBreakerSnapshot) => void;

  /**
   * Callback invoked when the circuit resets from HALF_OPEN to CLOSED.
   */
  readonly onReset?: () => void;

  /**
   * Callback invoked when the circuit enters HALF_OPEN probe state.
   */
  readonly onHalfOpen?: () => void;

  /**
   * Callback invoked when a fallback is executed.
   */
  readonly onFallback?: (operation: string, key?: string, error?: unknown) => void;
}

interface CallOutcome {
  readonly success: boolean;
  readonly slow: boolean;
  readonly timestamp: number;
}

export class CircuitBreaker {
  private state: CircuitBreakerState = "closed";
  private readonly adapterName: string;
  private readonly failureThreshold: number;
  private readonly baseResetTimeoutMs: number;
  private currentResetTimeoutMs: number;
  private readonly resetTimeoutBackoffFactor: number;
  private readonly maxResetTimeoutMs: number;
  private readonly halfOpenMaxProbes: number;
  private readonly consecutiveSuccessesNeeded: number;
  private readonly slowCallThresholdMs?: number;
  private readonly slowCallRateThreshold?: number;
  private readonly slidingWindowSize: number;
  private readonly minimumNumberOfCalls: number;
  private readonly isFailurePredicate: (error: unknown) => boolean;

  private readonly onStateChange?: (
    from: CircuitBreakerState,
    to: CircuitBreakerState,
    snapshot: CircuitBreakerSnapshot,
  ) => void;
  private readonly onTrip?: (error: unknown, snapshot: CircuitBreakerSnapshot) => void;
  private readonly onReset?: () => void;
  private readonly onHalfOpen?: () => void;

  private totalCalls = 0;
  private successfulCalls = 0;
  private failedCalls = 0;
  private slowCalls = 0;
  private rejectedCalls = 0;
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private halfOpenActiveProbes = 0;
  private lastFailureTimestamp?: number;
  private lastStateChangeTimestamp: number = Date.now();
  private openedAt = 0;

  private readonly slidingWindow: CallOutcome[] = [];

  constructor(adapterName: string, options: CircuitBreakerOptions = {}) {
    this.adapterName = adapterName;
    this.failureThreshold = options.failureThreshold ?? 5;
    this.baseResetTimeoutMs = options.resetTimeoutMs ?? 10_000;
    this.currentResetTimeoutMs = this.baseResetTimeoutMs;
    this.resetTimeoutBackoffFactor = options.resetTimeoutBackoffFactor ?? 1;
    this.maxResetTimeoutMs = options.maxResetTimeoutMs ?? 60_000;
    this.halfOpenMaxProbes = options.halfOpenMaxProbes ?? 1;
    this.consecutiveSuccessesNeeded = options.consecutiveSuccessesNeeded ?? 2;
    this.slowCallThresholdMs = options.slowCallThresholdMs;
    this.slowCallRateThreshold = options.slowCallRateThreshold;
    this.slidingWindowSize = options.slidingWindowSize ?? 20;
    this.minimumNumberOfCalls = options.minimumNumberOfCalls ?? 5;
    this.isFailurePredicate = options.isFailure ?? (() => true);

    this.onStateChange = options.onStateChange;
    this.onTrip = options.onTrip;
    this.onReset = options.onReset;
    this.onHalfOpen = options.onHalfOpen;
  }

  public get currentState(): CircuitBreakerState {
    this.checkStateTransition();
    return this.state;
  }

  public get isOpen(): boolean {
    return this.currentState === "open";
  }

  public get isClosed(): boolean {
    return this.currentState === "closed";
  }

  public get isHalfOpen(): boolean {
    return this.currentState === "half_open";
  }

  public getSnapshot(): CircuitBreakerSnapshot {
    this.checkStateTransition();
    const windowTotal = this.slidingWindow.length;
    const windowFailures = this.slidingWindow.filter((c) => !c.success).length;
    const windowSlow = this.slidingWindow.filter((c) => c.slow).length;

    const failureRate = windowTotal > 0 ? windowFailures / windowTotal : 0;
    const slowCallRate = windowTotal > 0 ? windowSlow / windowTotal : 0;

    let timeRemaining = 0;
    if (this.state === "open") {
      const elapsed = Date.now() - this.openedAt;
      timeRemaining = Math.max(0, this.currentResetTimeoutMs - elapsed);
    }

    return {
      state: this.state,
      totalCalls: this.totalCalls,
      successfulCalls: this.successfulCalls,
      failedCalls: this.failedCalls,
      slowCalls: this.slowCalls,
      rejectedCalls: this.rejectedCalls,
      failureRate,
      slowCallRate,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      lastFailureTimestamp: this.lastFailureTimestamp,
      lastStateChangeTimestamp: this.lastStateChangeTimestamp,
      timeRemainingUntilResetMs: timeRemaining,
    };
  }

  private checkStateTransition(): void {
    if (this.state === "open") {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed >= this.currentResetTimeoutMs) {
        this.transitionTo("half_open");
      }
    }
  }

  private transitionTo(nextState: CircuitBreakerState, error?: unknown): void {
    if (this.state === nextState) return;
    const prevState = this.state;
    this.state = nextState;
    this.lastStateChangeTimestamp = Date.now();

    if (nextState === "open") {
      this.openedAt = Date.now();
      this.consecutiveSuccesses = 0;
      this.halfOpenActiveProbes = 0;
      const snapshot = this.getSnapshot();
      if (this.onTrip) this.onTrip(error, snapshot);
    } else if (nextState === "half_open") {
      this.halfOpenActiveProbes = 0;
      this.consecutiveSuccesses = 0;
      if (this.onHalfOpen) this.onHalfOpen();
    } else if (nextState === "closed") {
      this.consecutiveFailures = 0;
      this.halfOpenActiveProbes = 0;
      this.currentResetTimeoutMs = this.baseResetTimeoutMs;
      this.slidingWindow.length = 0;
      if (this.onReset) this.onReset();
    }

    if (this.onStateChange) {
      this.onStateChange(prevState, nextState, this.getSnapshot());
    }
  }

  public trip(error?: unknown): void {
    if (this.state !== "open") {
      this.transitionTo("open", error);
    }
  }

  public reset(): void {
    this.transitionTo("closed");
  }

  public async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.checkStateTransition();

    if (this.state === "open") {
      this.rejectedCalls++;
      const elapsed = Date.now() - this.openedAt;
      const remaining = Math.max(0, this.currentResetTimeoutMs - elapsed);
      throw new CircuitBreakerOpenError(this.adapterName, this.currentResetTimeoutMs, remaining);
    }

    if (this.state === "half_open") {
      if (this.halfOpenActiveProbes >= this.halfOpenMaxProbes) {
        this.rejectedCalls++;
        throw new CircuitBreakerOpenError(this.adapterName, this.currentResetTimeoutMs, 0);
      }
      this.halfOpenActiveProbes++;
    }

    this.totalCalls++;
    const startTime = performance.now();
    try {
      const result = await fn();
      const durationMs = performance.now() - startTime;
      this.onCallSuccess(durationMs);
      return result;
    } catch (err) {
      const durationMs = performance.now() - startTime;
      this.onCallFailure(err, durationMs);
      throw err;
    } finally {
      if (this.state === "half_open" && this.halfOpenActiveProbes > 0) {
        this.halfOpenActiveProbes--;
      }
    }
  }

  private onCallSuccess(durationMs: number): void {
    this.successfulCalls++;
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses++;

    const isSlow = this.slowCallThresholdMs !== undefined && durationMs >= this.slowCallThresholdMs;
    if (isSlow) {
      this.slowCalls++;
    }

    this.pushSlidingWindow({
      success: true,
      slow: isSlow,
      timestamp: Date.now(),
    });

    if (this.state === "half_open") {
      if (this.consecutiveSuccesses >= this.consecutiveSuccessesNeeded) {
        this.transitionTo("closed");
      }
    } else if (this.state === "closed") {
      this.evaluateSlidingWindow();
    }
  }

  private onCallFailure(error: unknown, durationMs: number): void {
    if (!this.isFailurePredicate(error)) {
      return;
    }

    this.failedCalls++;
    this.consecutiveSuccesses = 0;
    this.consecutiveFailures++;
    this.lastFailureTimestamp = Date.now();

    const isSlow = this.slowCallThresholdMs !== undefined && durationMs >= this.slowCallThresholdMs;
    if (isSlow) {
      this.slowCalls++;
    }

    this.pushSlidingWindow({
      success: false,
      slow: isSlow,
      timestamp: Date.now(),
    });

    if (this.state === "half_open") {
      if (this.resetTimeoutBackoffFactor > 1) {
        this.currentResetTimeoutMs = Math.min(
          this.maxResetTimeoutMs,
          Math.round(this.currentResetTimeoutMs * this.resetTimeoutBackoffFactor),
        );
      }
      this.transitionTo("open", error);
      return;
    }

    if (this.state === "closed") {
      const isRateMode = this.failureThreshold > 0 && this.failureThreshold < 1;
      if (!isRateMode && this.consecutiveFailures >= this.failureThreshold) {
        this.transitionTo("open", error);
        return;
      }

      this.evaluateSlidingWindow(error);
    }
  }

  private pushSlidingWindow(outcome: CallOutcome): void {
    this.slidingWindow.push(outcome);
    if (this.slidingWindow.length > this.slidingWindowSize) {
      this.slidingWindow.shift();
    }
  }

  private evaluateSlidingWindow(error?: unknown): void {
    if (this.slidingWindow.length < this.minimumNumberOfCalls) {
      return;
    }

    const total = this.slidingWindow.length;
    const failures = this.slidingWindow.filter((c) => !c.success).length;
    const failureRate = failures / total;

    const isRateMode = this.failureThreshold > 0 && this.failureThreshold < 1;
    if (isRateMode && failureRate >= this.failureThreshold) {
      this.transitionTo("open", error);
      return;
    }

    if (this.slowCallRateThreshold !== undefined && this.slowCallThresholdMs !== undefined) {
      const slow = this.slidingWindow.filter((c) => c.slow).length;
      const slowRate = slow / total;
      if (slowRate >= this.slowCallRateThreshold) {
        this.transitionTo(
          "open",
          error ?? new Error(`Slow call rate exceeded threshold: ${slowRate}`),
        );
      }
    }
  }
}

export interface CircuitBreakerStorageAdapter extends StorageAdapter {
  readonly circuitBreaker: CircuitBreaker;
  readonly fallbackAdapter?: StorageAdapter;
}

export function withCircuitBreaker(
  adapter: StorageAdapter,
  options: CircuitBreakerOptions = {},
): CircuitBreakerStorageAdapter {
  const breaker = new CircuitBreaker(adapter.name, options);
  const fallback = options.fallbackAdapter;
  const degrade = options.degradeGracefully ?? false;
  const onFallback = options.onFallback;

  const handleFallback = async <T>(
    operation: string,
    key: string | undefined,
    error: unknown,
    _primaryExecution: () => Promise<T>,
    fallbackExecution?: (adapter: StorageAdapter) => Promise<T>,
    gracefulDefault?: () => T,
  ): Promise<T> => {
    if (onFallback) {
      onFallback(operation, key, error);
    }
    if (fallback && fallbackExecution) {
      return await fallbackExecution(fallback);
    }
    if (degrade && gracefulDefault) {
      return gracefulDefault();
    }
    throw error;
  };

  const executeWithBreaker = async <T>(
    operation: string,
    key: string | undefined,
    primaryCall: () => Promise<T>,
    fallbackCall?: (target: StorageAdapter) => Promise<T>,
    gracefulDefault?: () => T,
  ): Promise<T> => {
    try {
      return await breaker.execute(primaryCall);
    } catch (err) {
      return await handleFallback(operation, key, err, primaryCall, fallbackCall, gracefulDefault);
    }
  };

  const wrapped: CircuitBreakerStorageAdapter = {
    name: `circuit-breaker(${adapter.name})`,
    capabilities: { ...adapter.capabilities },
    circuitBreaker: breaker,
    fallbackAdapter: fallback,

    async get<T = unknown>(key: string): Promise<T | null> {
      return executeWithBreaker(
        "get",
        key,
        () => adapter.get<T>(key),
        (target) => target.get<T>(key),
        () => null,
      );
    },

    async set<T = unknown>(key: string, value: T, setOpts?: SetOptions): Promise<void> {
      return executeWithBreaker(
        "set",
        key,
        () => adapter.set(key, value, setOpts),
        (target) => target.set(key, value, setOpts),
        () => undefined,
      );
    },

    async delete(key: string): Promise<boolean> {
      return executeWithBreaker(
        "delete",
        key,
        () => adapter.delete(key),
        (target) => target.delete(key),
        () => false,
      );
    },

    async has(key: string): Promise<boolean> {
      return executeWithBreaker(
        "has",
        key,
        () => adapter.has(key),
        (target) => target.has(key),
        () => false,
      );
    },

    async clear(): Promise<void> {
      return executeWithBreaker(
        "clear",
        undefined,
        () => adapter.clear(),
        (target) => target.clear(),
        () => undefined,
      );
    },

    async keys(pattern?: string): Promise<string[]> {
      return executeWithBreaker(
        "keys",
        pattern,
        () => adapter.keys(pattern),
        (target) => target.keys(pattern),
        () => [],
      );
    },
  };

  const origGetMany = adapter.getMany?.bind(adapter);
  if (origGetMany) {
    wrapped.getMany = async <T = unknown>(keys: string[]): Promise<Map<string, T | null>> => {
      return executeWithBreaker(
        "getMany",
        keys.join(","),
        () => origGetMany<T>(keys),
        (target) =>
          target.getMany
            ? target.getMany<T>(keys)
            : Promise.all(keys.map(async (k) => [k, await target.get<T>(k)] as const)).then(
                (entries) => new Map(entries),
              ),
        () => new Map(keys.map((k) => [k, null])),
      );
    };
  }

  const origSetMany = adapter.setMany?.bind(adapter);
  if (origSetMany) {
    wrapped.setMany = async <T = unknown>(
      entries: Array<{ key: string; value: T; options?: SetOptions }>,
    ): Promise<void> => {
      return executeWithBreaker(
        "setMany",
        entries.map((e) => e.key).join(","),
        () => origSetMany(entries),
        async (target) => {
          if (target.setMany) {
            await target.setMany(entries);
          } else {
            for (const entry of entries) {
              await target.set(entry.key, entry.value, entry.options);
            }
          }
        },
        () => undefined,
      );
    };
  }

  const origDeleteMany = adapter.deleteMany?.bind(adapter);
  if (origDeleteMany) {
    wrapped.deleteMany = async (keys: string[]): Promise<number> => {
      return executeWithBreaker(
        "deleteMany",
        keys.join(","),
        () => origDeleteMany(keys),
        async (target) => {
          if (target.deleteMany) {
            return await target.deleteMany(keys);
          }
          let count = 0;
          for (const key of keys) {
            if (await target.delete(key)) count++;
          }
          return count;
        },
        () => 0,
      );
    };
  }

  const origCAS = adapter.compareAndSwap?.bind(adapter);
  if (origCAS) {
    wrapped.compareAndSwap = async <T = unknown>(
      key: string,
      expected: T | null,
      update: T,
      casOpts?: SetOptions,
    ): Promise<boolean> => {
      return executeWithBreaker(
        "compareAndSwap",
        key,
        () => origCAS<T>(key, expected, update, casOpts),
        async (target) => {
          if (target.compareAndSwap) {
            return await target.compareAndSwap<T>(key, expected, update, casOpts);
          }
          const current = await target.get<T>(key);
          if (current !== expected) return false;
          await target.set(key, update, casOpts);
          return true;
        },
        () => false,
      );
    };
  }

  const origScan = adapter.scan?.bind(adapter);
  if (origScan) {
    wrapped.scan = async function* (
      pattern?: string,
      scanOpts?: ScanOptions,
    ): AsyncIterable<string> {
      try {
        await breaker.execute(async () => true);
        yield* origScan(pattern, scanOpts);
      } catch (err) {
        if (onFallback) {
          onFallback("scan", pattern, err);
        }
        if (fallback) {
          if (fallback.scan) {
            yield* fallback.scan(pattern, scanOpts);
          } else {
            const fallbackKeys = await fallback.keys(pattern);
            for (const k of fallbackKeys) {
              yield k;
            }
          }
          return;
        }
        if (degrade) {
          return;
        }
        throw err;
      }
    };
  }

  if (adapter.disconnect) {
    wrapped.disconnect = async (): Promise<void> => {
      await adapter.disconnect?.();
      if (fallback?.disconnect) {
        await fallback.disconnect();
      }
    };
  }

  return wrapped;
}

export interface FailoverOptions {
  /**
   * Periodic background health check interval in milliseconds to test primary adapter.
   * When the primary adapter recovers, failover automatically reverts to primary.
   * Set to 0 or undefined to disable automatic periodic health checks.
   * @default 5000
   */
  readonly healthCheckIntervalMs?: number;

  /**
   * Key used for executing health checks.
   * @default "__kvdock_healthcheck__"
   */
  readonly healthCheckKey?: string;

  /**
   * When true, write operations (set, delete, clear, setMany, deleteMany)
   * are replicated to all healthy standby adapters to keep fallback caches warm.
   * @default false
   */
  readonly replicateWrites?: boolean;

  /**
   * Callback fired when failover switches to a standby adapter.
   */
  readonly onFailover?: (fromIndex: number, toIndex: number, error: unknown) => void;

  /**
   * Callback fired when primary adapter recovers and active adapter fails back.
   */
  readonly onFailback?: (fromIndex: number, toIndex: number) => void;
}

export interface FailoverStats {
  readonly activeIndex: number;
  readonly activeAdapterName: string;
  readonly failoverCount: number;
  readonly lastFailoverTimestamp?: number;
  readonly isPrimaryActive: boolean;
}

export interface FailoverStorageAdapter extends StorageAdapter {
  readonly activeIndex: number;
  readonly activeAdapter: StorageAdapter;
  readonly adapters: readonly StorageAdapter[];
  readonly stats: FailoverStats;
  failover(targetIndex?: number, error?: unknown): void;
  failback(): void;
  checkHealth(): Promise<boolean>;
}

export function withFailover(
  adapters: StorageAdapter[],
  options: FailoverOptions = {},
): FailoverStorageAdapter {
  if (!adapters || adapters.length === 0) {
    throw new Error("withFailover requires at least one StorageAdapter");
  }

  let currentIndex = 0;
  let failoverCount = 0;
  let lastFailoverTimestamp: number | undefined;
  let healthCheckTimer: ReturnType<typeof setInterval> | undefined;

  const healthCheckKey = options.healthCheckKey ?? "__kvdock_healthcheck__";
  const replicateWrites = options.replicateWrites ?? false;
  const onFailover = options.onFailover;
  const onFailback = options.onFailback;

  const switchTo = (targetIndex: number, error?: unknown): void => {
    if (targetIndex < 0 || targetIndex >= adapters.length || targetIndex === currentIndex) return;
    const prevIndex = currentIndex;
    currentIndex = targetIndex;
    failoverCount++;
    lastFailoverTimestamp = Date.now();

    if (targetIndex === 0) {
      if (onFailback) onFailback(prevIndex, targetIndex);
    } else {
      if (onFailover) onFailover(prevIndex, targetIndex, error);
    }
  };

  const tryExecute = async <T>(fn: (adapter: StorageAdapter) => Promise<T>): Promise<T> => {
    let lastError: unknown;
    const startIndex = currentIndex;

    for (let offset = 0; offset < adapters.length; offset++) {
      const idx = (startIndex + offset) % adapters.length;
      const target = adapters[idx];
      try {
        const result = await fn(target);
        if (idx !== currentIndex) {
          switchTo(idx);
        }
        return result;
      } catch (err) {
        lastError = err;
        if (offset === 0 && adapters.length > 1) {
          switchTo((startIndex + 1) % adapters.length, err);
        }
      }
    }

    throw lastError;
  };

  const tryReplicateWrite = async (
    writeFn: (adapter: StorageAdapter) => Promise<unknown>,
  ): Promise<void> => {
    if (!replicateWrites) return;
    for (let i = 0; i < adapters.length; i++) {
      if (i !== currentIndex) {
        try {
          await writeFn(adapters[i]);
        } catch {
          // Replication best-effort to standby caches
        }
      }
    }
  };

  const checkHealth = async (): Promise<boolean> => {
    const primary = adapters[0];
    try {
      await primary.has(healthCheckKey);
      if (currentIndex !== 0) {
        switchTo(0);
      }
      return true;
    } catch {
      return false;
    }
  };

  if (options.healthCheckIntervalMs && options.healthCheckIntervalMs > 0 && adapters.length > 1) {
    healthCheckTimer = setInterval(() => {
      if (currentIndex !== 0) {
        checkHealth().catch(() => {});
      }
    }, options.healthCheckIntervalMs);
    if (healthCheckTimer.unref) {
      healthCheckTimer.unref();
    }
  }

  const primaryAdapter = adapters[0];

  const failoverAdapter: FailoverStorageAdapter = {
    get name(): string {
      return `failover(${adapters[currentIndex].name})`;
    },
    capabilities: { ...primaryAdapter.capabilities },

    get activeIndex(): number {
      return currentIndex;
    },

    get activeAdapter(): StorageAdapter {
      return adapters[currentIndex];
    },

    get adapters(): readonly StorageAdapter[] {
      return adapters;
    },

    get stats(): FailoverStats {
      return {
        activeIndex: currentIndex,
        activeAdapterName: adapters[currentIndex].name,
        failoverCount,
        lastFailoverTimestamp,
        isPrimaryActive: currentIndex === 0,
      };
    },

    failover(targetIndex?: number, error?: unknown): void {
      const next = targetIndex ?? (currentIndex + 1) % adapters.length;
      switchTo(next, error);
    },

    failback(): void {
      switchTo(0);
    },

    checkHealth,

    async get<T = unknown>(key: string): Promise<T | null> {
      return tryExecute((target) => target.get<T>(key));
    },

    async set<T = unknown>(key: string, value: T, setOpts?: SetOptions): Promise<void> {
      const res = await tryExecute((target) => target.set(key, value, setOpts));
      await tryReplicateWrite((target) => target.set(key, value, setOpts));
      return res;
    },

    async delete(key: string): Promise<boolean> {
      const res = await tryExecute((target) => target.delete(key));
      await tryReplicateWrite((target) => target.delete(key));
      return res;
    },

    async has(key: string): Promise<boolean> {
      return tryExecute((target) => target.has(key));
    },

    async clear(): Promise<void> {
      const res = await tryExecute((target) => target.clear());
      await tryReplicateWrite((target) => target.clear());
      return res;
    },

    async keys(pattern?: string): Promise<string[]> {
      return tryExecute((target) => target.keys(pattern));
    },
  };

  if (primaryAdapter.capabilities.batch) {
    failoverAdapter.getMany = async <T = unknown>(
      keys: string[],
    ): Promise<Map<string, T | null>> => {
      return tryExecute(async (target) => {
        if (target.getMany) {
          return await target.getMany<T>(keys);
        }
        const map = new Map<string, T | null>();
        for (const k of keys) {
          map.set(k, await target.get<T>(k));
        }
        return map;
      });
    };

    failoverAdapter.setMany = async <T = unknown>(
      entries: Array<{ key: string; value: T; options?: SetOptions }>,
    ): Promise<void> => {
      await tryExecute(async (target) => {
        if (target.setMany) {
          await target.setMany(entries);
        } else {
          for (const e of entries) {
            await target.set(e.key, e.value, e.options);
          }
        }
      });
      await tryReplicateWrite(async (target) => {
        if (target.setMany) {
          await target.setMany(entries);
        } else {
          for (const e of entries) {
            await target.set(e.key, e.value, e.options);
          }
        }
      });
    };

    failoverAdapter.deleteMany = async (keys: string[]): Promise<number> => {
      const count = await tryExecute(async (target) => {
        if (target.deleteMany) {
          return await target.deleteMany(keys);
        }
        let deleted = 0;
        for (const k of keys) {
          if (await target.delete(k)) deleted++;
        }
        return deleted;
      });
      await tryReplicateWrite(async (target) => {
        if (target.deleteMany) {
          await target.deleteMany(keys);
        } else {
          for (const k of keys) {
            await target.delete(k);
          }
        }
      });
      return count;
    };
  }

  if (primaryAdapter.capabilities.cas) {
    failoverAdapter.compareAndSwap = async <T = unknown>(
      key: string,
      expected: T | null,
      update: T,
      casOpts?: SetOptions,
    ): Promise<boolean> => {
      return tryExecute(async (target) => {
        if (target.compareAndSwap) {
          return await target.compareAndSwap<T>(key, expected, update, casOpts);
        }
        const cur = await target.get<T>(key);
        if (cur !== expected) return false;
        await target.set(key, update, casOpts);
        return true;
      });
    };
  }

  if (primaryAdapter.capabilities.scan) {
    failoverAdapter.scan = async function* (
      pattern?: string,
      scanOpts?: ScanOptions,
    ): AsyncIterable<string> {
      const active = adapters[currentIndex];
      if (active.scan) {
        yield* active.scan(pattern, scanOpts);
      } else {
        const found = await active.keys(pattern);
        for (const k of found) {
          yield k;
        }
      }
    };
  }

  failoverAdapter.disconnect = async (): Promise<void> => {
    if (healthCheckTimer) {
      clearInterval(healthCheckTimer);
    }
    for (const a of adapters) {
      if (a.disconnect) {
        await a.disconnect();
      }
    }
  };

  return failoverAdapter;
}
