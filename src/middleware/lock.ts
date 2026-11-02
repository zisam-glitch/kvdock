import crypto from "node:crypto";
import { KVDockError } from "../core/errors.js";
import type { StorageAdapter } from "../core/types.js";

export interface MutexOptions {
  leaseMs?: number;
  retryIntervalMs?: number;
  maxWaitMs?: number;
}

export interface MutexAcquireOptions {
  leaseMs?: number;
}

export interface MutexWaitOptions extends MutexAcquireOptions {
  retryIntervalMs?: number;
  maxWaitMs?: number;
}

export interface LockHandle {
  readonly key: string;
  readonly holderId: string;
  readonly fencingToken: number;
  readonly acquiredAt: number;
  expiresAt: number;
  release(): Promise<boolean>;
  extend(additionalMs?: number): Promise<boolean>;
}

interface StoredLockPayload {
  holderId: string;
  fencingToken: number;
  expiresAt: number;
}

export class DistributedMutex {
  private readonly adapter: StorageAdapter;
  private readonly defaultLeaseMs: number;
  private readonly defaultRetryIntervalMs: number;
  private readonly defaultMaxWaitMs: number;

  constructor(adapter: StorageAdapter, options: MutexOptions = {}) {
    this.adapter = adapter;
    this.defaultLeaseMs = options.leaseMs ?? 5000;
    this.defaultRetryIntervalMs = options.retryIntervalMs ?? 50;
    this.defaultMaxWaitMs = options.maxWaitMs ?? 10000;
  }

  private lockKey(key: string): string {
    return `lock:${key}`;
  }

  private tokenCounterKey(key: string): string {
    return `lock:token:${key}`;
  }

  private async nextFencingToken(key: string): Promise<number> {
    const counterKey = this.tokenCounterKey(key);
    for (let i = 0; i < 50; i++) {
      const raw = await this.adapter.get<string>(counterKey);
      const current = raw ? Number.parseInt(String(raw), 10) : 0;
      const next = (Number.isNaN(current) ? 0 : current) + 1;

      if (this.adapter.compareAndSwap) {
        const ok = await this.adapter.compareAndSwap(counterKey, raw, String(next));
        if (ok) return next;
      } else {
        await this.adapter.set(counterKey, String(next));
        return next;
      }
    }
    return Date.now();
  }

  public async acquire(key: string, options?: MutexAcquireOptions): Promise<LockHandle | null> {
    const lKey = this.lockKey(key);
    const leaseMs = options?.leaseMs ?? this.defaultLeaseMs;
    const holderId = crypto.randomUUID();
    const now = Date.now();

    const rawExisting = await this.adapter.get<string>(lKey);
    let isAvailable = false;

    if (!rawExisting) {
      isAvailable = true;
    } else {
      try {
        const parsed: StoredLockPayload = JSON.parse(String(rawExisting));
        if (now >= parsed.expiresAt) {
          isAvailable = true;
        }
      } catch {
        isAvailable = true;
      }
    }

    if (!isAvailable) {
      return null;
    }

    const fencingToken = await this.nextFencingToken(key);
    const payload: StoredLockPayload = {
      holderId,
      fencingToken,
      expiresAt: now + leaseMs,
    };

    if (this.adapter.compareAndSwap) {
      const swapped = await this.adapter.compareAndSwap(
        lKey,
        rawExisting,
        JSON.stringify(payload),
        { ttl: leaseMs },
      );
      if (!swapped) return null;
    } else {
      if (rawExisting && !isAvailable) return null;
      await this.adapter.set(lKey, JSON.stringify(payload), { ttl: leaseMs });
    }

    const handle: LockHandle = {
      key,
      holderId,
      fencingToken,
      acquiredAt: now,
      expiresAt: now + leaseMs,
      release: async (): Promise<boolean> => {
        return this.release(key, holderId);
      },
      extend: async (additionalMs?: number): Promise<boolean> => {
        const extendBy = additionalMs ?? leaseMs;
        return this.extend(key, holderId, extendBy, handle);
      },
    };

    return handle;
  }

  public async acquireOrWait(key: string, options?: MutexWaitOptions): Promise<LockHandle> {
    const maxWaitMs = options?.maxWaitMs ?? this.defaultMaxWaitMs;
    const retryIntervalMs = options?.retryIntervalMs ?? this.defaultRetryIntervalMs;
    const deadline = Date.now() + maxWaitMs;

    while (Date.now() < deadline) {
      const handle = await this.acquire(key, options);
      if (handle) return handle;

      const remaining = deadline - Date.now();
      const delay = Math.min(retryIntervalMs, Math.max(5, remaining));
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    throw new KVDockError(
      `failed to acquire distributed lock for "${key}" within ${maxWaitMs}ms`,
      "ERR_ADAPTER",
    );
  }

  public async release(key: string, holderId: string): Promise<boolean> {
    const lKey = this.lockKey(key);
    const raw = await this.adapter.get<string>(lKey);
    if (!raw) return false;

    try {
      const parsed: StoredLockPayload = JSON.parse(String(raw));
      if (parsed.holderId !== holderId) {
        return false;
      }

      await this.adapter.delete(lKey);
      return true;
    } catch {
      await this.adapter.delete(lKey);
      return true;
    }
  }

  public async extend(
    key: string,
    holderId: string,
    additionalMs: number,
    handle?: LockHandle,
  ): Promise<boolean> {
    const lKey = this.lockKey(key);
    const raw = await this.adapter.get<string>(lKey);
    if (!raw) return false;

    try {
      const parsed: StoredLockPayload = JSON.parse(String(raw));
      if (parsed.holderId !== holderId) return false;

      const newExpiresAt = Date.now() + additionalMs;
      const updated: StoredLockPayload = {
        ...parsed,
        expiresAt: newExpiresAt,
      };

      if (this.adapter.compareAndSwap) {
        const ok = await this.adapter.compareAndSwap(lKey, raw, JSON.stringify(updated), {
          ttl: additionalMs,
        });
        if (ok && handle) {
          handle.expiresAt = newExpiresAt;
        }
        return ok;
      }

      await this.adapter.set(lKey, JSON.stringify(updated), {
        ttl: additionalMs,
      });
      if (handle) {
        handle.expiresAt = newExpiresAt;
      }
      return true;
    } catch {
      return false;
    }
  }

  public async runExclusive<T>(
    key: string,
    fn: (handle: LockHandle) => Promise<T>,
    options?: MutexWaitOptions,
  ): Promise<T> {
    const handle = await this.acquireOrWait(key, options);
    try {
      return await fn(handle);
    } finally {
      await handle.release();
    }
  }
}

export interface SemaphoreOptions {
  permits: number;
  leaseMs?: number;
  retryIntervalMs?: number;
  maxWaitMs?: number;
}

export interface SemaphoreHandle {
  readonly key: string;
  readonly holderId: string;
  readonly permitSlot: number;
  release(): Promise<boolean>;
}

export class DistributedSemaphore {
  private readonly mutex: DistributedMutex;
  private readonly adapter: StorageAdapter;
  private readonly maxPermits: number;
  private readonly defaultLeaseMs: number;
  private readonly defaultRetryIntervalMs: number;
  private readonly defaultMaxWaitMs: number;

  constructor(adapter: StorageAdapter, options: SemaphoreOptions) {
    if (options.permits < 1) {
      throw new KVDockError("permits must be at least 1", "ERR_CONDITION_FAILED");
    }
    this.adapter = adapter;
    this.mutex = new DistributedMutex(adapter, {
      leaseMs: 2000,
      retryIntervalMs: options.retryIntervalMs ?? 25,
      maxWaitMs: options.maxWaitMs ?? 5000,
    });
    this.maxPermits = options.permits;
    this.defaultLeaseMs = options.leaseMs ?? 5000;
    this.defaultRetryIntervalMs = options.retryIntervalMs ?? 50;
    this.defaultMaxWaitMs = options.maxWaitMs ?? 10000;
  }

  private registryKey(key: string): string {
    return `semaphore:${key}`;
  }

  public async acquire(
    key: string,
    options?: { leaseMs?: number },
  ): Promise<SemaphoreHandle | null> {
    const regKey = this.registryKey(key);
    const leaseMs = options?.leaseMs ?? this.defaultLeaseMs;
    const holderId = crypto.randomUUID();
    const now = Date.now();

    return this.mutex.runExclusive(
      `sem_internal:${key}`,
      async () => {
        const raw = await this.adapter.get<string>(regKey);
        let activeHolders: Array<{
          holderId: string;
          expiresAt: number;
          slot: number;
        }> = [];

        if (raw) {
          try {
            const list: Array<{
              holderId: string;
              expiresAt: number;
              slot: number;
            }> = JSON.parse(String(raw));
            activeHolders = list.filter((h) => h.expiresAt > now);
          } catch {
            activeHolders = [];
          }
        }

        if (activeHolders.length >= this.maxPermits) {
          return null;
        }

        const usedSlots = new Set(activeHolders.map((h) => h.slot));
        let slot = 0;
        while (usedSlots.has(slot)) {
          slot++;
        }

        activeHolders.push({
          holderId,
          expiresAt: now + leaseMs,
          slot,
        });

        await this.adapter.set(regKey, JSON.stringify(activeHolders), {
          ttl: leaseMs,
        });

        const handle: SemaphoreHandle = {
          key,
          holderId,
          permitSlot: slot,
          release: async () => this.release(key, holderId),
        };

        return handle;
      },
      { maxWaitMs: 3000 },
    );
  }

  public async acquireOrWait(
    key: string,
    options?: { leaseMs?: number; maxWaitMs?: number; retryIntervalMs?: number },
  ): Promise<SemaphoreHandle> {
    const maxWaitMs = options?.maxWaitMs ?? this.defaultMaxWaitMs;
    const retryIntervalMs = options?.retryIntervalMs ?? this.defaultRetryIntervalMs;
    const deadline = Date.now() + maxWaitMs;

    while (Date.now() < deadline) {
      const handle = await this.acquire(key, options);
      if (handle) return handle;

      const remaining = deadline - Date.now();
      const delay = Math.min(retryIntervalMs, Math.max(5, remaining));
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    throw new KVDockError(
      `failed to acquire semaphore permit for "${key}" within ${maxWaitMs}ms`,
      "ERR_ADAPTER",
    );
  }

  public async release(key: string, holderId: string): Promise<boolean> {
    const regKey = this.registryKey(key);
    return this.mutex.runExclusive(
      `sem_internal:${key}`,
      async () => {
        const raw = await this.adapter.get<string>(regKey);
        if (!raw) return false;

        try {
          const list: Array<{
            holderId: string;
            expiresAt: number;
            slot: number;
          }> = JSON.parse(String(raw));
          const filtered = list.filter((h) => h.holderId !== holderId);
          if (filtered.length === list.length) return false;

          await this.adapter.set(regKey, JSON.stringify(filtered));
          return true;
        } catch {
          return false;
        }
      },
      { maxWaitMs: 3000 },
    );
  }

  public async runWithPermit<T>(
    key: string,
    fn: (handle: SemaphoreHandle) => Promise<T>,
    options?: { leaseMs?: number; maxWaitMs?: number; retryIntervalMs?: number },
  ): Promise<T> {
    const handle = await this.acquireOrWait(key, options);
    try {
      return await fn(handle);
    } finally {
      await handle.release();
    }
  }
}
