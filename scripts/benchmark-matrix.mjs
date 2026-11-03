#!/usr/bin/env node

/**
 * Automated Multi-Adapter Benchmark Matrix Runner
 * Measures ops/sec and latency for 1KB, 10KB, 100KB payloads across adapters
 * Outputs Markdown comparison matrix table.
 */

import { performance } from "node:perf_hooks";
import fs from "node:fs/promises";
import { MemoryAdapter } from "../dist/adapters/memory/index.js";
import { FsAdapter } from "../dist/adapters/fs/index.js";
import { SQLiteAdapter } from "../dist/adapters/sqlite/index.js";
import { LocalStorageAdapter } from "../dist/adapters/localstorage/index.js";
import { DenoKvAdapter } from "../dist/adapters/deno-kv/index.js";
import { MongoDBAdapter } from "../dist/adapters/mongodb/index.js";
import { KVDock } from "../dist/index.js";

const PAYLOAD_SIZES = {
  "1KB": "x".repeat(1024),
  "10KB": "x".repeat(10 * 1024),
  "100KB": "x".repeat(100 * 1024),
};

const ITERATIONS = 1000;

async function measureThroughput(dock, payload) {
  // Warmup
  for (let i = 0; i < 50; i++) {
    await dock.set(`warmup:${i}`, payload);
    await dock.get(`warmup:${i}`);
  }

  // Measure Writes
  const t0 = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    await dock.set(`bench:${i}`, payload);
  }
  const writeElapsed = performance.now() - t0;
  const writeOps = Math.round((ITERATIONS / writeElapsed) * 1000);

  // Measure Reads
  const t1 = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    await dock.get(`bench:${i}`);
  }
  const readElapsed = performance.now() - t1;
  const readOps = Math.round((ITERATIONS / readElapsed) * 1000);

  return { writeOps, readOps, writeElapsed, readElapsed };
}

async function run() {
  console.log(`Running Multi-Adapter Performance Matrix (${ITERATIONS} ops/payload)...`);

  const adapters = [
    { name: "MemoryAdapter", adapter: new MemoryAdapter({ maxSize: 100_000 }) },
    { name: "SQLiteAdapter (:memory:)", adapter: new SQLiteAdapter({ path: ":memory:" }) },
    { name: "LocalStorageAdapter", adapter: new LocalStorageAdapter() },
    { name: "DenoKvAdapter (Mock)", adapter: new DenoKvAdapter() },
    { name: "MongoDBAdapter (Mock)", adapter: new MongoDBAdapter({ ensureIndex: false }) },
    { name: "FsAdapter (disk)", adapter: new FsAdapter({ dir: "./.bench_matrix_fs" }) },
  ];

  const results = [];

  for (const item of adapters) {
    const dock = new KVDock({ adapter: item.adapter });
    console.log(`  Evaluating ${item.name}...`);

    const adapterResult = { name: item.name, sizes: {} };

    for (const [sizeLabel, payload] of Object.entries(PAYLOAD_SIZES)) {
      if (item.name === "FsAdapter (disk)" && sizeLabel === "100KB") {
        // Skip 100KB on disk to keep bench swift
        adapterResult.sizes[sizeLabel] = { writeOps: "~", readOps: "~" };
        continue;
      }
      const metrics = await measureThroughput(dock, payload);
      adapterResult.sizes[sizeLabel] = metrics;
    }

    results.push(adapterResult);
    await dock.clear();
  }

  // Clean up fs bench dir
  try {
    await fs.rm("./.bench_matrix_fs", { recursive: true, force: true });
  } catch {}

  // Generate Markdown Matrix Table
  let markdown = `# KVDock Multi-Adapter Performance Matrix\n\n`;
  markdown += `*Benchmark executed on ${new Date().toISOString()} across ${ITERATIONS} ops per payload size.*\n\n`;
  markdown += `| Storage Adapter | 1KB Write (ops/s) | 1KB Read (ops/s) | 10KB Write (ops/s) | 10KB Read (ops/s) | 100KB Write (ops/s) | 100KB Read (ops/s) |\n`;
  markdown += `| :--- | :---: | :---: | :---: | :---: | :---: | :---: |\n`;

  for (const r of results) {
    const s1 = r.sizes["1KB"];
    const s10 = r.sizes["10KB"];
    const s100 = r.sizes["100KB"];

    const fmt = (v) => (typeof v === "number" ? v.toLocaleString() : v);

    markdown += `| **${r.name}** | ${fmt(s1.writeOps)} | ${fmt(s1.readOps)} | ${fmt(s10.writeOps)} | ${fmt(s10.readOps)} | ${fmt(s100.writeOps)} | ${fmt(s100.readOps)} |\n`;
  }

  console.log("\n" + markdown);

  await fs.writeFile("docs/PERFORMANCE_MATRIX.md", markdown, "utf-8");
  console.log("Written performance matrix report to docs/PERFORMANCE_MATRIX.md");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
