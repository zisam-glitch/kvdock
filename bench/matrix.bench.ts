import { bench, describe } from "vitest";
import { FsAdapter } from "../src/adapters/fs/index.js";
import { MemoryAdapter } from "../src/adapters/memory/index.js";
import { SQLiteAdapter } from "../src/adapters/sqlite/index.js";
import { KVDock } from "../src/core/store.js";

// Payloads: 1KB, 10KB, 100KB
const payload1KB = "x".repeat(1024);
const payload10KB = "x".repeat(10 * 1024);
const payload100KB = "x".repeat(100 * 1024);

describe("Benchmark Matrix: In-Memory Adapter", () => {
  const dock = new KVDock({ adapter: new MemoryAdapter({ maxSize: 100_000 }) });

  bench("Memory write 1KB payload", async () => {
    await dock.set("bench:mem:1kb", payload1KB);
  });

  bench("Memory read 1KB payload", async () => {
    await dock.get("bench:mem:1kb");
  });

  bench("Memory write 10KB payload", async () => {
    await dock.set("bench:mem:10kb", payload10KB);
  });

  bench("Memory read 10KB payload", async () => {
    await dock.get("bench:mem:10kb");
  });

  bench("Memory write 100KB payload", async () => {
    await dock.set("bench:mem:100kb", payload100KB);
  });

  bench("Memory read 100KB payload", async () => {
    await dock.get("bench:mem:100kb");
  });
});

describe("Benchmark Matrix: SQLite (In-Memory) Adapter", () => {
  const dock = new KVDock({ adapter: new SQLiteAdapter({ path: ":memory:" }) });

  bench("SQLite write 1KB payload", async () => {
    await dock.set("bench:sqlite:1kb", payload1KB);
  });

  bench("SQLite read 1KB payload", async () => {
    await dock.get("bench:sqlite:1kb");
  });

  bench("SQLite write 10KB payload", async () => {
    await dock.set("bench:sqlite:10kb", payload10KB);
  });

  bench("SQLite read 10KB payload", async () => {
    await dock.get("bench:sqlite:10kb");
  });
});

describe("Benchmark Matrix: FileSystem Adapter", () => {
  const dock = new KVDock({ adapter: new FsAdapter({ dir: "./.bench_fs_tmp" }) });

  bench("FS write 1KB payload", async () => {
    await dock.set("bench:fs:1kb", payload1KB);
  });

  bench("FS read 1KB payload", async () => {
    await dock.get("bench:fs:1kb");
  });
});
