import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/adapters/memory/index.ts",
    "src/adapters/fs/index.ts",
    "src/adapters/redis/index.ts",
    "src/adapters/upstash/index.ts"
  ],
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  splitting: false
});
