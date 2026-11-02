#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

const adapterName = process.argv[2]?.toLowerCase()?.trim();

if (!adapterName) {
  console.error("Usage: npm run create:adapter <name>");
  console.error("Example: npm run create:adapter valkey");
  process.exit(1);
}

const targetDir = join(rootDir, "src", "adapters", adapterName);

if (existsSync(targetDir)) {
  console.error(`Error: Adapter "${adapterName}" already exists at src/adapters/${adapterName}`);
  process.exit(1);
}

mkdirSync(targetDir, { recursive: true });

// Convert kebab-case or snake_case to PascalCase
const pascalName = adapterName
  .split(/[-_]/)
  .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
  .join("");

const indexTsContent = `import type {
  AdapterCapabilities,
  ScanOptions,
  SetOptions,
  StorageAdapter,
} from "../../core/types.js";

export interface ${pascalName}AdapterOptions {
  prefix?: string;
  // TODO: Add adapter-specific configuration options (e.g. client, connection string)
}

export class ${pascalName}Adapter implements StorageAdapter {
  public readonly name = "${adapterName}";
  public readonly capabilities: AdapterCapabilities = {
    ttl: true,
    batch: true,
    scan: true,
    cas: false,
    binary: false,
    stream: true,
  };

  private readonly prefix: string;

  constructor(options: ${pascalName}AdapterOptions = {}) {
    this.prefix = options.prefix ?? "";
  }

  private pkey(key: string): string {
    return this.prefix ? \`\${this.prefix}\${key}\` : key;
  }

  private unpkey(prefixed: string): string {
    if (this.prefix && prefixed.startsWith(this.prefix)) {
      return prefixed.slice(this.prefix.length);
    }
    return prefixed;
  }

  public async get<T = unknown>(key: string): Promise<T | null> {
    // TODO: Implement get operation
    return null;
  }

  public async set<T = unknown>(key: string, value: T, options?: SetOptions): Promise<void> {
    // TODO: Implement set operation with options (ttl, nx, xx)
  }

  public async delete(key: string): Promise<boolean> {
    // TODO: Implement delete operation
    return false;
  }

  public async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== null;
  }

  public async clear(): Promise<void> {
    // TODO: Implement clear operation
  }

  public async keys(pattern?: string): Promise<string[]> {
    // TODO: Implement keys listing
    return [];
  }

  public async *scan(pattern?: string, _options?: ScanOptions): AsyncIterable<string> {
    const all = await this.keys(pattern);
    for (const key of all) {
      yield key;
    }
  }

  public async disconnect(): Promise<void> {
    // TODO: Clean up client connections
  }
}
`;

const indexTestTsContent = `import { describe, expect, it } from "vitest";
import { defineAdapterTestSuite } from "../../testing/index.js";
import { ${pascalName}Adapter } from "./index.js";

defineAdapterTestSuite({
  name: "${pascalName}Adapter",
  createAdapter: () => new ${pascalName}Adapter(),
});

describe("${pascalName}Adapter Custom Tests", () => {
  it("initializes successfully", () => {
    const adapter = new ${pascalName}Adapter();
    expect(adapter.name).toBe("${adapterName}");
  });
});
`;

const indexBenchTsContent = `import { bench, describe } from "vitest";
import { ${pascalName}Adapter } from "./index.js";

describe("${pascalName}Adapter Benchmarks", () => {
  const adapter = new ${pascalName}Adapter();

  bench("set operation", async () => {
    await adapter.set("bench:key", "value");
  });

  bench("get operation", async () => {
    await adapter.get("bench:key");
  });
});
`;

writeFileSync(join(targetDir, "index.ts"), indexTsContent, "utf-8");
writeFileSync(join(targetDir, "index.test.ts"), indexTestTsContent, "utf-8");
writeFileSync(join(targetDir, "index.bench.ts"), indexBenchTsContent, "utf-8");

// Update package.json
const pkgJsonPath = join(rootDir, "package.json");
const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
pkg.exports[`./adapters/${adapterName}`] = {
  types: `./dist/adapters/${adapterName}/index.d.ts`,
  import: `./dist/adapters/${adapterName}/index.js`,
  require: `./dist/adapters/${adapterName}/index.cjs`,
};
writeFileSync(pkgJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");

// Update tsup.config.ts
const tsupPath = join(rootDir, "tsup.config.ts");
let tsupContent = readFileSync(tsupPath, "utf-8");
const entryPattern = /entry:\s*\[([\s\S]*?)\]/;
const match = tsupContent.match(entryPattern);
if (match) {
  const newEntry = `    "src/adapters/${adapterName}/index.ts",\n`;
  const updatedEntries = match[1] + newEntry;
  tsupContent = tsupContent.replace(entryPattern, `entry: [${updatedEntries}]`);
  writeFileSync(tsupPath, tsupContent, "utf-8");
}

console.log(`\n🎉 Successfully scaffolded adapter: ${adapterName}!`);
console.log(`Files created:`);
console.log(`  - src/adapters/${adapterName}/index.ts`);
console.log(`  - src/adapters/${adapterName}/index.test.ts`);
console.log(`  - src/adapters/${adapterName}/index.bench.ts`);
console.log(`\nUpdated package.json exports and tsup.config.ts.`);
console.log(`\nNext steps for contributor:`);
console.log(`  1. Implement storage logic in src/adapters/${adapterName}/index.ts`);
console.log(`  2. Run 'npm test' to verify compliance with defineAdapterTestSuite`);
console.log(`  3. Run 'npm run check' to format and lint`);
