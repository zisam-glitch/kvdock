import type {
  AdapterCapabilities,
  ScanOptions,
  SetOptions,
  StorageAdapter,
} from "../../core/types.js";

/**
 * 4-bit saturated Count-Min Sketch frequency estimator with periodic aging.
 */
class CountMinSketch {
  private readonly table: Uint8Array;
  private readonly width: number;
  private readonly mask: number;
  private additions = 0;
  private readonly sampleSize: number;

  constructor(capacity: number) {
    // Next power of 2 for fast bitwise masking
    let w = 1;
    while (w < capacity * 2) {
      w <<= 1;
    }
    this.width = Math.max(64, w);
    this.mask = this.width - 1;
    // 4 rows of 4-bit counters packed into Uint8Array (2 counters per byte)
    this.table = new Uint8Array((4 * this.width) >> 1);
    this.sampleSize = Math.max(100, capacity * 10);
  }

  private hash(key: string, seed: number): number {
    let h = seed ^ key.length;
    for (let i = 0; i < key.length; i++) {
      h = Math.imul(h ^ key.charCodeAt(i), 0x5bd1e995);
      h ^= h >>> 15;
    }
    return (h ^ (h >>> 13)) & this.mask;
  }

  private getCounter(row: number, col: number): number {
    const index = (row * this.width + col) >> 1;
    const isOdd = col & 1;
    const byte = this.table[index];
    return isOdd ? (byte >>> 4) & 0x0f : byte & 0x0f;
  }

  private incrementCounter(row: number, col: number): boolean {
    const index = (row * this.width + col) >> 1;
    const isOdd = col & 1;
    const byte = this.table[index];
    const val = isOdd ? (byte >>> 4) & 0x0f : byte & 0x0f;
    if (val < 15) {
      if (isOdd) {
        this.table[index] = (byte & 0x0f) | ((val + 1) << 4);
      } else {
        this.table[index] = (byte & 0xf0) | (val + 1);
      }
      return true;
    }
    return false;
  }

  public recordAccess(key: string): void {
    const seeds = [0x9747b28c, 0xc13fa9a9, 0x1b873593, 0x5bd1e995];
    for (let i = 0; i < 4; i++) {
      const col = this.hash(key, seeds[i]);
      this.incrementCounter(i, col);
    }

    this.additions++;
    if (this.additions >= this.sampleSize) {
      this.age();
    }
  }

  public estimateFrequency(key: string): number {
    const seeds = [0x9747b28c, 0xc13fa9a9, 0x1b873593, 0x5bd1e995];
    let min = 15;
    for (let i = 0; i < 4; i++) {
      const col = this.hash(key, seeds[i]);
      const count = this.getCounter(i, col);
      if (count < min) min = count;
    }
    return min;
  }

  /**
   * Halves all counters (frequency aging) when sampleSize is reached.
   */
  private age(): void {
    for (let i = 0; i < this.table.length; i++) {
      const b = this.table[i];
      const low = (b & 0x0f) >> 1;
      const high = ((b >>> 4) & 0x0f) >> 1;
      this.table[i] = low | (high << 4);
    }
    this.additions >>>= 1;
  }

  public clear(): void {
    this.table.fill(0);
    this.additions = 0;
  }
}

interface InternalEntry {
  value: string;
  expiresAt: number | null;
}

export interface WTinyLFUAdapterOptions {
  /**
   * Maximum capacity of the cache.
   * @default 10000
   */
  readonly maxSize?: number;

  /**
   * Interval in milliseconds to sweep expired TTL keys.
   * @default 30000
   */
  readonly cleanupIntervalMs?: number;
}

export class MemoryWTinyLFUAdapter implements StorageAdapter {
  public readonly name = "memory-wtinylfu";
  public readonly capabilities: AdapterCapabilities = {
    ttl: true,
    batch: true,
    scan: true,
    cas: true,
    binary: false,
    stream: true,
  };

  private readonly maxSize: number;
  private readonly maxWindowSize: number;
  private readonly maxProtectedSize: number;

  private readonly sketch: CountMinSketch;

  // Windowed Segmented LRU compartments
  private readonly window = new Map<string, InternalEntry>();
  private readonly probation = new Map<string, InternalEntry>();
  private readonly protected = new Map<string, InternalEntry>();

  private cleanupTimer?: NodeJS.Timeout;

  constructor(options: WTinyLFUAdapterOptions = {}) {
    this.maxSize = Math.max(10, options.maxSize ?? 10_000);
    // Window cache gets 20% of capacity to absorb bursts
    this.maxWindowSize = Math.max(1, Math.floor(this.maxSize * 0.2));
    const mainCapacity = this.maxSize - this.maxWindowSize;
    // Protected gets ~80% of main cache, Probationary gets ~20%
    this.maxProtectedSize = Math.max(1, Math.floor(mainCapacity * 0.8));

    this.sketch = new CountMinSketch(this.maxSize);

    if (options.cleanupIntervalMs && options.cleanupIntervalMs > 0) {
      this.cleanupTimer = setInterval(() => {
        this.sweep();
      }, options.cleanupIntervalMs);
      if (this.cleanupTimer.unref) {
        this.cleanupTimer.unref();
      }
    }
  }

  private isExpired(entry: InternalEntry): boolean {
    return entry.expiresAt !== null && entry.expiresAt <= Date.now();
  }

  private findEntry(
    key: string,
  ): { entry: InternalEntry; region: "window" | "probation" | "protected" } | null {
    const w = this.window.get(key);
    if (w) return { entry: w, region: "window" };

    const pr = this.probation.get(key);
    if (pr) return { entry: pr, region: "probation" };

    const pt = this.protected.get(key);
    if (pt) return { entry: pt, region: "protected" };

    return null;
  }

  public async get<T = unknown>(key: string): Promise<T | null> {
    const located = this.findEntry(key);
    if (!located) return null;

    if (this.isExpired(located.entry)) {
      await this.delete(key);
      return null;
    }

    // Record hit frequency in sketch
    this.sketch.recordAccess(key);

    // Promote in LRU
    if (located.region === "window") {
      this.window.delete(key);
      this.window.set(key, located.entry);
    } else if (located.region === "probation") {
      // Hit in probation promotes to protected segment!
      this.probation.delete(key);
      this.protected.set(key, located.entry);

      // If protected segment overflows, demote its LRU victim to probation
      if (this.protected.size > this.maxProtectedSize) {
        const victimKey = this.protected.keys().next().value;
        if (victimKey) {
          const victimEntry = this.protected.get(victimKey);
          if (victimEntry) {
            this.protected.delete(victimKey);
            this.probation.set(victimKey, victimEntry);
          }
        }
      }
    } else if (located.region === "protected") {
      // Touch in protected LRU
      this.protected.delete(key);
      this.protected.set(key, located.entry);
    }

    return located.entry.value as unknown as T;
  }

  public async set<T = unknown>(key: string, value: T, options?: SetOptions): Promise<void> {
    const stringVal = String(value);
    const ttl = options?.ttl;
    const expiresAt = ttl && ttl > 0 ? Date.now() + ttl : null;
    const entry: InternalEntry = { value: stringVal, expiresAt };

    if (options?.nx) {
      if (await this.has(key)) return;
    }
    if (options?.xx) {
      if (!(await this.has(key))) return;
    }

    this.sketch.recordAccess(key);

    const existing = this.findEntry(key);
    if (existing) {
      // Update in-place in its current compartment
      if (existing.region === "window") {
        this.window.delete(key);
        this.window.set(key, entry);
      } else if (existing.region === "protected") {
        this.protected.delete(key);
        this.protected.set(key, entry);
      } else {
        this.probation.delete(key);
        this.probation.set(key, entry);
      }
      return;
    }

    // New item admission enters Window Cache
    this.window.set(key, entry);

    // If Window Cache overflows, evict candidate and run TinyLFU admission check
    if (this.window.size > this.maxWindowSize) {
      const candidateKey = this.window.keys().next().value;
      if (candidateKey) {
        const candidateEntry = this.window.get(candidateKey);
        if (candidateEntry) {
          this.window.delete(candidateKey);
          this.admit(candidateKey, candidateEntry);
        }
      }
    }
  }

  /**
   * TinyLFU admission policy: compares candidate from window against probation victim.
   */
  private admit(candidateKey: string, candidateEntry: InternalEntry): void {
    const mainCapacity = this.maxSize - this.maxWindowSize;
    if (this.probation.size + this.protected.size < mainCapacity) {
      this.probation.set(candidateKey, candidateEntry);
      return;
    }

    // Main cache is actually at capacity: compare candidate against probation victim
    const victimKey = this.probation.keys().next().value;
    if (!victimKey) {
      this.probation.set(candidateKey, candidateEntry);
      return;
    }

    const candidateFreq = this.sketch.estimateFrequency(candidateKey);
    const victimFreq = this.sketch.estimateFrequency(victimKey);

    if (candidateFreq > victimFreq) {
      // Candidate wins: evict victim from probation and insert candidate
      this.probation.delete(victimKey);
      this.probation.set(candidateKey, candidateEntry);
    }
    // Else: victim retained, candidate discarded
  }

  public async delete(key: string): Promise<boolean> {
    const deletedWindow = this.window.delete(key);
    const deletedProbation = this.probation.delete(key);
    const deletedProtected = this.protected.delete(key);
    return deletedWindow || deletedProbation || deletedProtected;
  }

  public async has(key: string): Promise<boolean> {
    const located = this.findEntry(key);
    if (!located) return false;
    if (this.isExpired(located.entry)) {
      await this.delete(key);
      return false;
    }
    return true;
  }

  public async clear(): Promise<void> {
    this.window.clear();
    this.probation.clear();
    this.protected.clear();
    this.sketch.clear();
  }

  public async keys(pattern?: string): Promise<string[]> {
    this.sweep();
    const all = new Set([
      ...this.window.keys(),
      ...this.probation.keys(),
      ...this.protected.keys(),
    ]);

    if (!pattern || pattern === "*") {
      return Array.from(all);
    }

    const regex = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`);
    return Array.from(all).filter((k) => regex.test(k));
  }

  public async getMany<T = unknown>(keys: string[]): Promise<Map<string, T | null>> {
    const map = new Map<string, T | null>();
    for (const key of keys) {
      map.set(key, await this.get<T>(key));
    }
    return map;
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
    for (const key of keys) {
      if (await this.delete(key)) count++;
    }
    return count;
  }

  public async compareAndSwap<T = unknown>(
    key: string,
    expected: T | null,
    update: T,
    options?: SetOptions,
  ): Promise<boolean> {
    const current = await this.get<string>(key);
    const expStr = expected === null ? null : String(expected);

    if (current === expStr) {
      await this.set(key, update, options);
      return true;
    }
    return false;
  }

  public async *scan(pattern?: string, _options?: ScanOptions): AsyncIterable<string> {
    const matchedKeys = await this.keys(pattern);
    for (const k of matchedKeys) {
      yield k;
    }
  }

  public sweep(): number {
    let swept = 0;
    const now = Date.now();

    for (const [k, v] of this.window.entries()) {
      if (v.expiresAt !== null && v.expiresAt <= now) {
        this.window.delete(k);
        swept++;
      }
    }
    for (const [k, v] of this.probation.entries()) {
      if (v.expiresAt !== null && v.expiresAt <= now) {
        this.probation.delete(k);
        swept++;
      }
    }
    for (const [k, v] of this.protected.entries()) {
      if (v.expiresAt !== null && v.expiresAt <= now) {
        this.protected.delete(k);
        swept++;
      }
    }

    return swept;
  }

  public async disconnect(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    await this.clear();
  }
}
