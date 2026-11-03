import { IDBCursor, IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineAdapterTestSuite } from "../../testing/index.js";
import { IndexedDBAdapter } from "./index.js";

async function collectKeys(keys: AsyncIterable<string>): Promise<string[]> {
  const result: string[] = [];
  for await (const key of keys) result.push(key);
  return result;
}

defineAdapterTestSuite({
  name: "IndexedDBAdapter",
  createAdapter: () => new IndexedDBAdapter({ factory: new IDBFactory() }),
});

describe("IndexedDBAdapter scan", () => {
  const adapters: IndexedDBAdapter[] = [];

  function createAdapter(options: ConstructorParameters<typeof IndexedDBAdapter>[0] = {}) {
    const adapter = new IndexedDBAdapter({ factory: new IDBFactory(), ...options });
    adapters.push(adapter);
    return adapter;
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(adapters.splice(0).map((adapter) => adapter.disconnect()));
  });

  it("starts lazily and only reads one batch when the consumer stops early", async () => {
    const adapter = createAdapter();
    await adapter.setMany(["a", "b", "c", "d", "e"].map((key) => ({ key, value: key })));
    const keys = vi.spyOn(adapter, "keys");
    const getAll = vi.spyOn(IDBObjectStore.prototype, "getAll");
    const getAllKeys = vi.spyOn(IDBObjectStore.prototype, "getAllKeys");
    const openCursor = vi.spyOn(IDBObjectStore.prototype, "openCursor");
    const advance = vi.spyOn(IDBCursor.prototype, "continue");
    const iterator = adapter.scan(undefined, { batchSize: 2 })[Symbol.asyncIterator]();

    expect(openCursor).not.toHaveBeenCalled();
    expect(await iterator.next()).toEqual({ value: "a", done: false });
    expect(getAll).not.toHaveBeenCalled();
    expect(openCursor).toHaveBeenCalledTimes(1);
    expect(advance).toHaveBeenCalledTimes(1);
    expect(await iterator.next()).toEqual({ value: "b", done: false });
    await iterator.return?.();

    expect(openCursor).toHaveBeenCalledTimes(1);
    expect(keys).not.toHaveBeenCalled();
    expect(getAll).not.toHaveBeenCalled();
    expect(getAllKeys).not.toHaveBeenCalled();
  });

  it.each([1, 2, 3, 100])("resumes after consumer pauses with batchSize %i", async (batchSize) => {
    const adapter = createAdapter();
    const expected = ["", "a", "aa", "b", "z", "Ω", "😀"];
    await adapter.setMany(expected.map((key) => ({ key, value: key })));
    const result: string[] = [];

    for await (const key of adapter.scan("*", { batchSize })) {
      result.push(key);
      // A real IndexedDB transaction becomes inactive while the consumer is idle.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(result).toEqual(expected);
  });

  it("filters prefixes, patterns and expired records across empty batches", async () => {
    const factory = new IDBFactory();
    const adapter = createAdapter({ factory, prefix: "app:" });
    const other = createAdapter({ factory, prefix: "other:" });
    await adapter.set("expired", "old", { ttl: -1 });
    await adapter.set("skip", "not matched");
    await adapter.set("user:1", "first");
    await adapter.set("user:2", "second");
    await other.set("user:3", "different prefix");

    expect(await collectKeys(adapter.scan("user:*", { batchSize: 1 }))).toEqual([
      "user:1",
      "user:2",
    ]);
    expect(await adapter.keys("user:*")).toEqual(["user:1", "user:2"]);
    expect(await collectKeys(other.scan())).toEqual(["user:3"]);
  });

  it("finishes an empty store", async () => {
    expect(await collectKeys(createAdapter().scan())).toEqual([]);
  });

  it("retains batch and compare-and-swap behaviour with native-style transactions", async () => {
    const adapter = createAdapter();
    expect(await adapter.compareAndSwap("counter", null, "1")).toBe(true);
    expect(await adapter.compareAndSwap("counter", "0", "2")).toBe(false);
    expect(await adapter.get("counter")).toBe("1");
    expect(await adapter.compareAndSwap("counter", "1", "2")).toBe(true);
    expect(await adapter.deleteMany(["counter", "missing"])).toBe(1);
    expect(await collectKeys(adapter.scan())).toEqual([]);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid batchSize %s",
    async (batchSize) => {
      const iterator = createAdapter().scan(undefined, { batchSize })[Symbol.asyncIterator]();
      await expect(iterator.next()).rejects.toThrow("batchSize must be a positive safe integer");
    },
  );

  it("propagates cursor request errors", async () => {
    const adapter = createAdapter();
    const error = new DOMException("Cursor failed", "UnknownError");
    vi.spyOn(IDBObjectStore.prototype, "openCursor").mockImplementation(() => {
      const request = { result: null, error, onsuccess: null, onerror: null };
      queueMicrotask(() => {
        (request.onerror as ((event: Event) => void) | null)?.(new Event("error"));
      });
      return request as unknown as IDBRequest<IDBCursorWithValue | null>;
    });

    await expect(collectKeys(adapter.scan())).rejects.toBe(error);
  });

  it("rejects a transaction abort instead of hanging", async () => {
    const adapter = createAdapter();
    const openCursor = IDBObjectStore.prototype.openCursor;
    vi.spyOn(IDBObjectStore.prototype, "openCursor").mockImplementation(function (
      this: IDBObjectStore,
    ) {
      const request = openCursor.call(this);
      this.transaction.abort();
      return request;
    });

    await expect(collectKeys(adapter.scan())).rejects.toThrow();
  });
});
