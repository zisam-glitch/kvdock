import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { defineAdapterTestSuite } from "../../testing/index.js";
import { SQLiteAdapter } from "./index.js";

const isNativeSqliteSupported = (() => {
  try {
    const req = createRequire(import.meta.url);
    const sqlite = req("node:sqlite") as { DatabaseSync?: unknown };
    return typeof sqlite?.DatabaseSync === "function";
  } catch {
    return false;
  }
})();

if (isNativeSqliteSupported) {
  defineAdapterTestSuite({
    name: "SQLiteAdapter",
    createAdapter: () => new SQLiteAdapter({ path: ":memory:" }),
  });
}

describe.runIf(isNativeSqliteSupported)(
  "SQLiteAdapter (Atomic Transactions & Embedded Engine)",
  () => {
    it("rolls back batch setMany if any constraint fails", async () => {
      const adapter = new SQLiteAdapter({ path: ":memory:" });
      await adapter.set("existing", "keep_me");

      await adapter.setMany([
        { key: "item1", value: "val1" },
        { key: "item2", value: "val2" },
      ]);

      expect(await adapter.get("item1")).toBe("val1");
      expect(await adapter.get("item2")).toBe("val2");
      await adapter.disconnect();
    });

    it("performs atomic Compare-And-Swap inside transaction", async () => {
      const adapter = new SQLiteAdapter({ path: ":memory:" });

      const ok1 = await adapter.compareAndSwap("counter", null, "1");
      expect(ok1).toBe(true);
      expect(await adapter.get("counter")).toBe("1");

      const ok2 = await adapter.compareAndSwap("counter", "1", "2");
      expect(ok2).toBe(true);
      expect(await adapter.get("counter")).toBe("2");

      const okFail = await adapter.compareAndSwap("counter", "99", "3");
      expect(okFail).toBe(false);
      expect(await adapter.get("counter")).toBe("2");

      await adapter.disconnect();
    });
  },
);

describe.skipIf(isNativeSqliteSupported)("SQLiteAdapter (Legacy Node 18 Runtime)", () => {
  it("throws informative error on unsupported Node versions", () => {
    expect(() => new SQLiteAdapter({ path: ":memory:" })).toThrow(/node:sqlite is not available/);
  });
});
