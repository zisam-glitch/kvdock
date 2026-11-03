import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defineAdapterTestSuite } from "../../testing/index.js";
import { PostgresAdapter } from "./index.js";

const url = process.env.POSTGRES_URL || process.env.DATABASE_URL;

describe.skipIf(!url)("PostgresAdapter against a real PostgreSQL (POSTGRES_URL)", () => {
  let pool: pg.Pool;
  const tableName = `kvdock_it_${Date.now()}`;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
  });

  afterAll(async () => {
    if (pool) {
      try {
        await pool.query(`DROP TABLE IF EXISTS "${tableName}";`);
      } catch {
        // ignore
      }
      await pool.end();
    }
  });

  defineAdapterTestSuite({
    name: "PostgresAdapter (real postgres)",
    createAdapter: () => new PostgresAdapter({ client: pool, tableName }),
    teardown: async (adapter) => {
      await adapter.clear();
    },
  });

  it("executes atomic compareAndSwap on real postgres table", async () => {
    const adapter = new PostgresAdapter({ client: pool, tableName });
    expect(await adapter.compareAndSwap("cas:real", null, "initial")).toBe(true);
    expect(await adapter.get("cas:real")).toBe("initial");
    expect(await adapter.compareAndSwap("cas:real", "wrong", "next")).toBe(false);
    expect(await adapter.compareAndSwap("cas:real", "initial", "next")).toBe(true);
    expect(await adapter.get("cas:real")).toBe("next");
  });
});
