import { bench, describe } from "vitest";
import { MemoryAdapter } from "../adapters/memory/index.js";
import { defaultSerializer, rawSerializer } from "./serializer.js";
import { KVDock } from "./store.js";

describe("KVDock Core Throughput Benchmarks", () => {
  const jsonDock = new KVDock({
    adapter: new MemoryAdapter({ maxSize: 100_000 }),
    serializer: defaultSerializer,
  });

  const rawDock = new KVDock({
    adapter: new MemoryAdapter({ maxSize: 100_000 }),
    serializer: rawSerializer,
  });

  bench("set with defaultSerializer (JSON)", async () => {
    await jsonDock.set("bench:json", { id: 123, role: "admin", active: true });
  });

  bench("set with rawSerializer", async () => {
    await rawDock.set("bench:raw", "raw_string_data_benchmark");
  });

  bench("get hit path", async () => {
    await jsonDock.get("bench:json");
  });

  bench("get miss path", async () => {
    await jsonDock.get("bench:nonexistent_key");
  });

  bench("getOrSet cached path", async () => {
    await jsonDock.getOrSet("bench:json", () => ({ fallback: true }));
  });
});
