import { describe, expect, it } from "vitest";
import { defineAdapterTestSuite } from "../../testing/index.js";
import { IndexedDBAdapter } from "./index.js";

interface MockRecord {
  key: string;
  value: string;
  expiresAt: number | null;
}

interface MockIDBRequest<T> {
  result: T;
  error: Error | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

// Clean in-memory IDBFactory mock for unit testing
function createMockIDBFactory(): IDBFactory {
  const databases = new Map<string, Map<string, Map<string, MockRecord>>>();

  return {
    open(name: string) {
      let dbStores = databases.get(name);
      if (!dbStores) {
        dbStores = new Map();
        databases.set(name, dbStores);
      }
      const activeDbStores = dbStores;

      const openReq: {
        result: unknown;
        error: Error | null;
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
        onupgradeneeded: (() => void) | null;
      } = {
        result: null,
        error: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
      };

      const mockDb = {
        objectStoreNames: {
          contains: (store: string) => activeDbStores.has(store),
        },
        createObjectStore: (store: string) => {
          if (!activeDbStores.has(store)) {
            activeDbStores.set(store, new Map());
          }
        },
        transaction: (storeName: string) => {
          let storeMap = activeDbStores.get(storeName);
          if (!storeMap) {
            storeMap = new Map();
            activeDbStores.set(storeName, storeMap);
          }
          const activeStoreMap = storeMap;

          return {
            objectStore: () => ({
              get: (key: string) => {
                const getReq: MockIDBRequest<MockRecord | undefined> = {
                  result: activeStoreMap.get(key),
                  error: null,
                  onsuccess: null,
                  onerror: null,
                };
                queueMicrotask(() => getReq.onsuccess?.());
                return getReq;
              },
              getAll: () => {
                const getAllReq: MockIDBRequest<MockRecord[]> = {
                  result: Array.from(activeStoreMap.values()),
                  error: null,
                  onsuccess: null,
                  onerror: null,
                };
                queueMicrotask(() => getAllReq.onsuccess?.());
                return getAllReq;
              },
              put: (record: MockRecord) => {
                activeStoreMap.set(record.key, record);
                const putReq: MockIDBRequest<void> = {
                  result: undefined,
                  error: null,
                  onsuccess: null,
                  onerror: null,
                };
                queueMicrotask(() => putReq.onsuccess?.());
                return putReq;
              },
              delete: (key: string) => {
                activeStoreMap.delete(key);
                const delReq: MockIDBRequest<void> = {
                  result: undefined,
                  error: null,
                  onsuccess: null,
                  onerror: null,
                };
                queueMicrotask(() => delReq.onsuccess?.());
                return delReq;
              },
              clear: () => {
                activeStoreMap.clear();
                const clrReq: MockIDBRequest<void> = {
                  result: undefined,
                  error: null,
                  onsuccess: null,
                  onerror: null,
                };
                queueMicrotask(() => clrReq.onsuccess?.());
                return clrReq;
              },
            }),
          };
        },
        close: () => {},
      };

      queueMicrotask(() => {
        openReq.result = mockDb;
        openReq.onupgradeneeded?.();
        openReq.onsuccess?.();
      });

      return openReq as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
}

defineAdapterTestSuite({
  name: "IndexedDBAdapter",
  createAdapter: () =>
    new IndexedDBAdapter({
      dbName: `test_db_${Math.random()}`,
      factory: createMockIDBFactory(),
    }),
});

describe("IndexedDBAdapter (Browser Environment)", () => {
  it("initializes and performs basic operations", async () => {
    const adapter = new IndexedDBAdapter({
      dbName: "browser_test",
      factory: createMockIDBFactory(),
    });

    await adapter.set("theme", "dracula");
    expect(await adapter.get("theme")).toBe("dracula");
    expect(await adapter.has("theme")).toBe(true);

    await adapter.delete("theme");
    expect(await adapter.has("theme")).toBe(false);
  });
});
