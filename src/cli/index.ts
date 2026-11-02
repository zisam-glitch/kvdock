#!/usr/bin/env node

import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { FsAdapter } from "../adapters/fs/index.js";
import { MemoryAdapter } from "../adapters/memory/index.js";
import { SQLiteAdapter } from "../adapters/sqlite/index.js";
import { KVDock } from "../core/store.js";
import type { StorageAdapter } from "../core/types.js";

function isNodeSqliteAvailable(): boolean {
  try {
    const req = createRequire(import.meta.url);
    const sqlite = req("node:sqlite") as { DatabaseSync?: unknown };
    return typeof sqlite?.DatabaseSync === "function";
  } catch {
    return false;
  }
}

function printHelp(): void {
  console.log(`
kvdock CLI - Universal Key-Value Engine Tool

Usage:
  kvdock <command> [arguments] [options]

Commands:
  get <key>                  Retrieve a key value
  set <key> <value>          Store a key value
  del <key>                  Delete a key
  keys [pattern]             List stored keys
  bench                      Run benchmark on specified adapter
  doctor                     Inspect runtime environment and adapter capabilities

Options:
  --adapter=<type>           Storage adapter: memory (default), fs, sqlite
  --ttl=<ms>                 Time to live in milliseconds
  --dir=<path>               Directory for fs adapter (default: ./.kvdock)
  --json                     Output response formatted as JSON
  --ops=<num>                Number of benchmark operations (default: 5000)
  --help, -h                 Show help information
  --version, -v              Show version
`);
}

function parseArgs(args: string[]): {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
} {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (const arg of args) {
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        const key = arg.slice(2, eqIdx);
        flags[key] = arg.slice(eqIdx + 1);
      } else {
        flags[arg.slice(2)] = true;
      }
    } else if (arg.startsWith("-")) {
      flags[arg.slice(1)] = true;
    } else {
      positionals.push(arg);
    }
  }

  const command = positionals[0] || "help";
  return { command, positionals: positionals.slice(1), flags };
}

function resolveAdapter(flags: Record<string, string | boolean>): StorageAdapter {
  const type = String(flags.adapter || "memory").toLowerCase();
  switch (type) {
    case "fs":
      return new FsAdapter({ dir: typeof flags.dir === "string" ? flags.dir : undefined });
    case "sqlite":
      return new SQLiteAdapter({ path: typeof flags.dir === "string" ? flags.dir : ":memory:" });
    default:
      return new MemoryAdapter();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const { command, positionals, flags } = parseArgs(args);

  if (flags.help || flags.h || command === "help") {
    printHelp();
    process.exit(0);
  }

  if (flags.version || flags.v || command === "version") {
    console.log("kvdock v0.1.0");
    process.exit(0);
  }

  const isJson = Boolean(flags.json);

  try {
    switch (command) {
      case "get": {
        const key = positionals[0];
        if (!key) {
          console.error("Error: Missing required argument <key>");
          process.exit(1);
        }

        const adapter = resolveAdapter(flags);
        const dock = new KVDock({ adapter });
        const val = await dock.get(key);

        if (val === null) {
          if (isJson) console.log(JSON.stringify({ found: false, value: null }));
          else console.error(`Key not found: ${key}`);
          process.exit(1);
        }

        if (isJson) console.log(JSON.stringify({ found: true, key, value: val }));
        else console.log(typeof val === "object" ? JSON.stringify(val, null, 2) : String(val));
        break;
      }

      case "set": {
        const key = positionals[0];
        const val = positionals[1];
        if (!key || val === undefined) {
          console.error("Error: Missing required arguments <key> <value>");
          process.exit(1);
        }

        const ttl = flags.ttl ? Number(flags.ttl) : undefined;
        const adapter = resolveAdapter(flags);
        const dock = new KVDock({ adapter });
        await dock.set(key, val, { ttl });

        if (isJson) console.log(JSON.stringify({ ok: true, key, ttl }));
        else console.log(`OK: Set "${key}"`);
        break;
      }

      case "del": {
        const key = positionals[0];
        if (!key) {
          console.error("Error: Missing required argument <key>");
          process.exit(1);
        }

        const adapter = resolveAdapter(flags);
        const dock = new KVDock({ adapter });
        const deleted = await dock.delete(key);

        if (isJson) console.log(JSON.stringify({ ok: deleted, key }));
        else console.log(deleted ? `OK: Deleted "${key}"` : `Key not found: "${key}"`);
        if (!deleted) process.exit(1);
        break;
      }

      case "keys": {
        const pattern = positionals[0] || "*";
        const adapter = resolveAdapter(flags);
        const dock = new KVDock({ adapter });
        const keys = await dock.keys(pattern);

        if (isJson) console.log(JSON.stringify({ count: keys.length, keys }));
        else {
          for (const k of keys) console.log(k);
        }
        break;
      }

      case "doctor": {
        const adapter = resolveAdapter(flags);
        const dock = new KVDock({ adapter });
        const info = {
          runtime: typeof process !== "undefined" ? `Node.js ${process.version}` : "Unknown",
          adapter: dock.adapterName,
          capabilities: dock.capabilities,
          nodeSqliteNative: isNodeSqliteAvailable(),
        };

        if (isJson) {
          console.log(JSON.stringify(info, null, 2));
        } else {
          console.log("kvdock Doctor Report:");
          console.log(`  Runtime:      ${info.runtime}`);
          console.log(`  Adapter:      ${info.adapter}`);
          console.log(`  Capabilities: ${JSON.stringify(info.capabilities)}`);
          console.log(`  Node SQLite:  ${info.nodeSqliteNative ? "Available" : "Not present"}`);
        }
        break;
      }

      case "bench": {
        const ops = flags.ops ? Number(flags.ops) : 5000;
        const adapter = resolveAdapter(flags);
        const dock = new KVDock({ adapter });

        console.log(`Benchmarking ${dock.adapterName} adapter (${ops} operations)...`);

        const t0 = performance.now();
        for (let i = 0; i < ops; i++) {
          await dock.set(`bench:${i}`, { idx: i, data: "payload" });
        }
        const writeElapsed = performance.now() - t0;

        const t1 = performance.now();
        for (let i = 0; i < ops; i++) {
          await dock.get(`bench:${i}`);
        }
        const readElapsed = performance.now() - t1;

        const writeOpsPerSec = Math.round((ops / writeElapsed) * 1000);
        const readOpsPerSec = Math.round((ops / readElapsed) * 1000);

        if (isJson) {
          console.log(
            JSON.stringify({
              adapter: dock.adapterName,
              ops,
              writes: { elapsedMs: writeElapsed, opsSec: writeOpsPerSec },
              reads: { elapsedMs: readElapsed, opsSec: readOpsPerSec },
            }),
          );
        } else {
          console.log(
            `  Writes: ${writeOpsPerSec.toLocaleString()} ops/sec (${writeElapsed.toFixed(2)} ms)`,
          );
          console.log(
            `  Reads:  ${readOpsPerSec.toLocaleString()} ops/sec (${readElapsed.toFixed(2)} ms)`,
          );
        }
        await dock.clear();
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        printHelp();
        process.exit(1);
    }
  } catch (err: unknown) {
    const error = err as Error;
    if (isJson) {
      console.error(JSON.stringify({ error: error.message }));
    } else {
      console.error(`Error: ${error.message}`);
    }
    process.exit(2);
  }
}

main();
