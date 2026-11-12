import { KVDock } from "../../core/store.js";
import type { GetOrSetOptions, ScanOptions, SetOptions, StorageAdapter } from "../../core/types.js";

export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => Promise<StandardResult<Output>> | StandardResult<Output>;
  };
}

export type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | {
      readonly issues: ReadonlyArray<{
        readonly message: string;
        readonly path?: ReadonlyArray<PropertyKey | { key: PropertyKey }>;
      }>;
    };

export type SchemaValidator<T> =
  | StandardSchemaV1<unknown, T>
  | { parse(data: unknown): T }
  | {
      safeParse(data: unknown): { success: true; data: T } | { success: false; error: unknown };
    }
  | ((data: unknown) => T);

export interface SchemaValidationOptions {
  /**
   * Action to take when cached data fails schema validation.
   * - "null": return null (treated as cache miss)
   * - "delete": evict the corrupted key from cache and return null (auto-healing)
   * - "throw": throw a ValidationError
   * @default "delete"
   */
  readonly onInvalid?: "null" | "delete" | "throw";
}

export class SchemaValidationError extends Error {
  public readonly key: string;
  public readonly rawValue: unknown;
  public readonly cause?: unknown;

  constructor(key: string, message: string, rawValue: unknown, cause?: unknown) {
    super(`Schema validation failed for cache key '${key}': ${message}`);
    this.name = "SchemaValidationError";
    this.key = key;
    this.rawValue = rawValue;
    this.cause = cause;
  }
}

async function validateWithSchema<T>(
  schema: SchemaValidator<T>,
  data: unknown,
  key: string,
): Promise<T> {
  if (typeof schema === "object" && schema !== null && "~standard" in schema) {
    const std = (schema as StandardSchemaV1<unknown, T>)["~standard"];
    const result = await std.validate(data);
    if (result.issues && result.issues.length > 0) {
      const msg = result.issues.map((i) => i.message).join("; ");
      throw new SchemaValidationError(key, msg, data, result.issues);
    }
    return (result as { value: T }).value;
  }

  if (typeof schema === "object" && schema !== null && "safeParse" in schema) {
    const res = (
      schema as {
        safeParse(
          d: unknown,
        ): { success: true; data: unknown } | { success: false; error: unknown };
      }
    ).safeParse(data);
    if (!res.success) {
      throw new SchemaValidationError(key, String(res.error), data, res.error);
    }
    return res.data as T;
  }

  if (typeof schema === "object" && schema !== null && "parse" in schema) {
    try {
      return (schema as { parse(d: unknown): T }).parse(data);
    } catch (err) {
      throw new SchemaValidationError(key, String(err), data, err);
    }
  }

  if (typeof schema === "function") {
    try {
      return schema(data);
    } catch (err) {
      throw new SchemaValidationError(key, String(err), data, err);
    }
  }

  return data as T;
}

export class TypedKVDock<T> {
  public readonly dock: KVDock;
  private readonly schema: SchemaValidator<T>;
  private readonly onInvalid: "null" | "delete" | "throw";

  constructor(
    target: KVDock | StorageAdapter,
    schema: SchemaValidator<T>,
    options: SchemaValidationOptions = {},
  ) {
    this.dock = target instanceof KVDock ? target : new KVDock({ adapter: target });
    this.schema = schema;
    this.onInvalid = options.onInvalid ?? "delete";
  }

  public async get(key: string): Promise<T | null> {
    const raw = await this.dock.get(key);
    if (raw === null || raw === undefined) return null;

    try {
      return await validateWithSchema(this.schema, raw, key);
    } catch (err) {
      if (this.onInvalid === "delete") {
        await this.dock.delete(key);
        return null;
      }
      if (this.onInvalid === "null") {
        return null;
      }
      throw err;
    }
  }

  public async set(key: string, value: T, options?: SetOptions): Promise<void> {
    // Validate prior to setting to ensure cache integrity
    const validated = await validateWithSchema(this.schema, value, key);
    await this.dock.set(key, validated, options);
  }

  public async getOrSet(
    key: string,
    fetcher: () => Promise<T> | T,
    options?: GetOrSetOptions,
  ): Promise<T> {
    return this.dock.getOrSet(
      key,
      async () => {
        const fresh = await fetcher();
        return await validateWithSchema(this.schema, fresh, key);
      },
      options,
    );
  }

  public async has(key: string): Promise<boolean> {
    return this.dock.has(key);
  }

  public async delete(key: string): Promise<boolean> {
    return this.dock.delete(key);
  }

  public async deleteMany(keys: string[]): Promise<number> {
    return this.dock.deleteMany(keys);
  }

  public async clear(): Promise<void> {
    return this.dock.clear();
  }

  public async keys(pattern?: string): Promise<string[]> {
    return this.dock.keys(pattern);
  }

  public scan(pattern?: string, options?: ScanOptions): AsyncIterable<string> {
    return this.dock.scan(pattern, options);
  }
}

/**
 * Wraps a KVDock store or StorageAdapter with a runtime schema validator (Zod, Valibot, Standard Schema).
 */
export function withSchema<T>(
  dockOrAdapter: KVDock | StorageAdapter,
  schema: SchemaValidator<T>,
  options?: SchemaValidationOptions,
): TypedKVDock<T> {
  return new TypedKVDock<T>(dockOrAdapter, schema, options);
}
