import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/testing/index.ts",
    "src/adapters/memory/index.ts",
    "src/adapters/fs/index.ts",
    "src/adapters/redis/index.ts",
    "src/adapters/upstash/index.ts",
    "src/adapters/cloudflare-kv/index.ts",
    "src/adapters/sqlite/index.ts",
    "src/adapters/indexeddb/index.ts",
    "src/cli/index.ts",
  ],
  format: ["cjs", "esm"],
  dts: true,
  platform: "node",
  target: "node18",
  clean: true,
  sourcemap: true,
  treeshake: true,
  splitting: false,
  external: ["node:sqlite"],
});
