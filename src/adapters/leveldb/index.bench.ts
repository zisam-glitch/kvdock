import { bench, describe } from "vitest";
import { LevelDBAdapter } from "./index.js";

describe("LevelDBAdapter Benchmarks", () => {
  const adapter = new LevelDBAdapter();

  bench("set operation", async () => {
    await adapter.set("bench:key", "value");
  });

  bench("get operation", async () => {
    await adapter.get("bench:key");
  });

  bench("batch set operation", async () => {
    await adapter.setMany([
      { key: "bench:batch:1", value: "one" },
      { key: "bench:batch:2", value: "two" },
      { key: "bench:batch:3", value: "three" },
    ]);
  });
});
