import type { KVDockEvent, ScanOptions, SetOptions, StorageAdapter } from "../../core/types.js";

export interface SpanContext {
  traceId: string;
  spanId: string;
  traceFlags: number;
  traceState?: string;
  isRemote?: boolean;
}

export interface SpanLike {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(status: { code: number; message?: string }): void;
  recordException(exception: Error): void;
  end(): void;
  spanContext?(): SpanContext;
  isRecording?(): boolean;
  addEvent?(name: string, attributes?: Record<string, unknown>, time?: number): void;
}

export interface SpanOptionsLike {
  attributes?: Record<string, unknown>;
  parent?: SpanContext | SpanLike;
  links?: Array<{ context: SpanContext; attributes?: Record<string, unknown> }>;
  kind?: number;
  startTime?: number;
  root?: boolean;
}

export interface TracerLike {
  startSpan(name: string, options?: SpanOptionsLike, context?: unknown): SpanLike;
}

export interface TextMapGetter<Carrier = unknown> {
  get(carrier: Carrier, key: string): string | string[] | undefined;
  keys(carrier: Carrier): string[];
}

export interface TextMapSetter<Carrier = unknown> {
  set(carrier: Carrier, key: string, value: string): void;
}

export interface TextMapPropagator<Carrier = unknown> {
  inject(context: SpanContext, carrier: Carrier, setter?: TextMapSetter<Carrier>): void;
  extract(carrier: Carrier, getter?: TextMapGetter<Carrier>): SpanContext | undefined;
}

export interface TraceOperationOptions {
  carrier?: unknown;
  parentContext?: SpanContext | SpanLike;
  attributes?: Record<string, unknown>;
  injectCarrier?: unknown;
  baggage?: Record<string, string>;
}

export interface WrapAdapterOptions {
  serviceName?: string;
  carrierGetter?: () => unknown;
}

export interface OpenTelemetryPluginOptions {
  tracer?: TracerLike;
  serviceName?: string;
  recordHitsAndMisses?: boolean;
  propagator?: TextMapPropagator;
  baggagePropagator?: W3CBaggagePropagator;
  defaultAttributes?: Record<string, unknown>;
}

const TRACEPARENT_REGEX = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/i;

export function parseTraceparent(header: string): SpanContext | undefined {
  if (typeof header !== "string") return undefined;
  const trimmed = header.trim();
  const match = TRACEPARENT_REGEX.exec(trimmed);
  if (!match) return undefined;

  const version = match[1].toLowerCase();
  const traceId = match[2].toLowerCase();
  const spanId = match[3].toLowerCase();
  const flagsHex = match[4].toLowerCase();
  const rest = match[5];

  if (version === "ff") return undefined;
  if (traceId === "00000000000000000000000000000000") return undefined;
  if (spanId === "0000000000000000") return undefined;

  if (version === "00" && (rest !== undefined || trimmed.length !== 55)) {
    return undefined;
  }

  const traceFlags = Number.parseInt(flagsHex, 16);

  return {
    traceId,
    spanId,
    traceFlags,
    isRemote: true,
  };
}

export function createTraceparent(context: SpanContext): string {
  const version = "00";
  const traceId = context.traceId.toLowerCase().padStart(32, "0");
  const spanId = context.spanId.toLowerCase().padStart(16, "0");
  const flags = (context.traceFlags & 0xff).toString(16).padStart(2, "0");
  return `${version}-${traceId}-${spanId}-${flags}`;
}

export function parseTracestate(header: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (typeof header !== "string" || !header.trim()) return result;

  const parts = header.trim().split(",");
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (key && val) {
      result[key] = val;
    }
  }
  return result;
}

export function createTracestate(entries: Record<string, string>): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(entries)) {
    if (key && value !== undefined && value !== null) {
      pairs.push(`${key}=${value}`);
    }
  }
  return pairs.join(",");
}

export function parseBaggage(header: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (typeof header !== "string" || !header.trim()) return result;

  const items = header.trim().split(",");
  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const [entry] = trimmed.split(";");
    const eqIdx = entry.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = entry.slice(0, eqIdx).trim();
    const rawVal = entry.slice(eqIdx + 1).trim();
    try {
      result[key] = decodeURIComponent(rawVal);
    } catch {
      result[key] = rawVal;
    }
  }
  return result;
}

export function createBaggage(entries: Record<string, string>): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(entries)) {
    if (key && value !== undefined && value !== null) {
      pairs.push(`${key}=${encodeURIComponent(value)}`);
    }
  }
  return pairs.join(", ");
}

function getRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  if (typeof globalThis !== "undefined" && globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return bytes;
}

export function generateTraceId(): string {
  for (let attempt = 0; attempt < 5; attempt++) {
    const bytes = getRandomBytes(16);
    let hex = "";
    for (let i = 0; i < bytes.length; i++) {
      hex += bytes[i].toString(16).padStart(2, "0");
    }
    if (hex !== "00000000000000000000000000000000") {
      return hex;
    }
  }
  return "00000000000000000000000000000001";
}

export function generateSpanId(): string {
  for (let attempt = 0; attempt < 5; attempt++) {
    const bytes = getRandomBytes(8);
    let hex = "";
    for (let i = 0; i < bytes.length; i++) {
      hex += bytes[i].toString(16).padStart(2, "0");
    }
    if (hex !== "0000000000000000") {
      return hex;
    }
  }
  return "0000000000000001";
}

export const defaultTextMapGetter: TextMapGetter = {
  get(carrier: unknown, key: string): string | undefined {
    if (!carrier || typeof carrier !== "object") return undefined;

    if (carrier instanceof Map) {
      const lowerKey = key.toLowerCase();
      for (const [k, v] of carrier.entries()) {
        if (typeof k === "string" && k.toLowerCase() === lowerKey) {
          return typeof v === "string" ? v : String(v);
        }
      }
      return undefined;
    }

    if (typeof (carrier as { get?: unknown }).get === "function") {
      const val = (carrier as { get(k: string): string | null }).get(key);
      return val ?? undefined;
    }

    const targetKey = key.toLowerCase();
    for (const [k, v] of Object.entries(carrier as Record<string, unknown>)) {
      if (k.toLowerCase() === targetKey) {
        if (Array.isArray(v)) {
          return v[0];
        }
        if (typeof v === "string") {
          return v;
        }
        if (v !== undefined && v !== null) {
          return String(v);
        }
      }
    }
    return undefined;
  },

  keys(carrier: unknown): string[] {
    if (!carrier || typeof carrier !== "object") return [];

    if (carrier instanceof Map) {
      return Array.from(carrier.keys()).map(String);
    }

    if (typeof (carrier as { keys?: unknown }).keys === "function") {
      try {
        return Array.from((carrier as { keys(): Iterable<string> }).keys());
      } catch {
        // Fallback to Object.keys
      }
    }

    return Object.keys(carrier as Record<string, unknown>);
  },
};

export const defaultTextMapSetter: TextMapSetter = {
  set(carrier: unknown, key: string, value: string): void {
    if (!carrier || typeof carrier !== "object") return;

    if (typeof (carrier as { set?: unknown }).set === "function") {
      (carrier as { set(k: string, v: string): void }).set(key, value);
      return;
    }

    (carrier as Record<string, unknown>)[key] = value;
  },
};

export class W3CTraceContextPropagator implements TextMapPropagator {
  public inject(
    context: SpanContext,
    carrier: unknown,
    setter: TextMapSetter = defaultTextMapSetter,
  ): void {
    const traceparent = createTraceparent(context);
    setter.set(carrier, "traceparent", traceparent);

    if (context.traceState) {
      setter.set(carrier, "tracestate", context.traceState);
    }
  }

  public extract(
    carrier: unknown,
    getter: TextMapGetter = defaultTextMapGetter,
  ): SpanContext | undefined {
    const rawTraceparent = getter.get(carrier, "traceparent");
    if (!rawTraceparent || typeof rawTraceparent !== "string") {
      return undefined;
    }

    const context = parseTraceparent(rawTraceparent.trim());
    if (!context) return undefined;

    const rawTracestate = getter.get(carrier, "tracestate");
    if (typeof rawTracestate === "string" && rawTracestate.trim().length > 0) {
      context.traceState = rawTracestate.trim();
    }

    return context;
  }
}

export class W3CBaggagePropagator {
  public inject(
    baggage: Record<string, string>,
    carrier: unknown,
    setter: TextMapSetter = defaultTextMapSetter,
  ): void {
    const header = createBaggage(baggage);
    if (header) {
      setter.set(carrier, "baggage", header);
    }
  }

  public extract(
    carrier: unknown,
    getter: TextMapGetter = defaultTextMapGetter,
  ): Record<string, string> | undefined {
    const rawBaggage = getter.get(carrier, "baggage");
    if (!rawBaggage || typeof rawBaggage !== "string") {
      return undefined;
    }
    return parseBaggage(rawBaggage.trim());
  }
}

export class CompositePropagator implements TextMapPropagator {
  private readonly propagators: readonly TextMapPropagator[];

  constructor(propagators: readonly TextMapPropagator[]) {
    this.propagators = propagators;
  }

  public inject(
    context: SpanContext,
    carrier: unknown,
    setter: TextMapSetter = defaultTextMapSetter,
  ): void {
    for (const propagator of this.propagators) {
      propagator.inject(context, carrier, setter);
    }
  }

  public extract(
    carrier: unknown,
    getter: TextMapGetter = defaultTextMapGetter,
  ): SpanContext | undefined {
    let resultContext: SpanContext | undefined;
    for (const propagator of this.propagators) {
      const extracted = propagator.extract(carrier, getter);
      if (extracted) {
        resultContext = resultContext
          ? {
              ...resultContext,
              ...extracted,
              traceState: extracted.traceState ?? resultContext.traceState,
            }
          : extracted;
      }
    }
    return resultContext;
  }
}

export class KVDockOpenTelemetryPlugin {
  private readonly tracer?: TracerLike;
  private readonly serviceName: string;
  private readonly recordHitsAndMisses: boolean;
  private readonly propagator: TextMapPropagator;
  private readonly baggagePropagator: W3CBaggagePropagator;
  private readonly defaultAttributes: Record<string, unknown>;
  private activeSpanContext?: SpanContext;

  constructor(options: OpenTelemetryPluginOptions = {}) {
    this.tracer = options.tracer;
    this.serviceName = options.serviceName ?? "kvdock";
    this.recordHitsAndMisses = options.recordHitsAndMisses ?? true;
    this.propagator = options.propagator ?? new W3CTraceContextPropagator();
    this.baggagePropagator = options.baggagePropagator ?? new W3CBaggagePropagator();
    this.defaultAttributes = options.defaultAttributes ?? {};
  }

  public getActiveContext(): SpanContext | undefined {
    return this.activeSpanContext;
  }

  public setActiveContext(context?: SpanContext): void {
    this.activeSpanContext = context;
  }

  public injectContext<TCarrier = Record<string, unknown>>(
    carrier: TCarrier,
    spanContext?: SpanContext,
    setter: TextMapSetter<TCarrier> = defaultTextMapSetter as TextMapSetter<TCarrier>,
  ): TCarrier {
    const contextToInject = spanContext ??
      this.activeSpanContext ?? {
        traceId: generateTraceId(),
        spanId: generateSpanId(),
        traceFlags: 1,
      };

    this.propagator.inject(contextToInject, carrier, setter as TextMapSetter<unknown>);
    return carrier;
  }

  public extractContext<TCarrier = unknown>(
    carrier: TCarrier,
    getter: TextMapGetter<TCarrier> = defaultTextMapGetter as TextMapGetter<TCarrier>,
  ): SpanContext | undefined {
    return this.propagator.extract(carrier, getter as TextMapGetter<unknown>);
  }

  public injectBaggage<TCarrier = Record<string, unknown>>(
    carrier: TCarrier,
    baggage: Record<string, string>,
    setter: TextMapSetter<TCarrier> = defaultTextMapSetter as TextMapSetter<TCarrier>,
  ): TCarrier {
    this.baggagePropagator.inject(baggage, carrier, setter as TextMapSetter<unknown>);
    return carrier;
  }

  public extractBaggage<TCarrier = unknown>(
    carrier: TCarrier,
    getter: TextMapGetter<TCarrier> = defaultTextMapGetter as TextMapGetter<TCarrier>,
  ): Record<string, string> | undefined {
    return this.baggagePropagator.extract(carrier, getter as TextMapGetter<unknown>);
  }

  public onEvent(event: KVDockEvent): void {
    if (!this.tracer) return;

    if (!this.recordHitsAndMisses && (event.type === "hit" || event.type === "miss")) {
      return;
    }

    let eventParentContext: SpanContext | undefined;
    if (event.meta?.carrier) {
      eventParentContext = this.extractContext(event.meta.carrier);
    } else if (typeof event.meta?.traceparent === "string") {
      eventParentContext = parseTraceparent(event.meta.traceparent);
      if (eventParentContext && typeof event.meta.tracestate === "string") {
        eventParentContext.traceState = event.meta.tracestate;
      }
    } else if (event.meta?.spanContext) {
      eventParentContext = event.meta.spanContext as SpanContext;
    } else if (this.activeSpanContext) {
      eventParentContext = this.activeSpanContext;
    }

    const spanName = `kvdock.${event.type}`;
    const attributes: Record<string, unknown> = {
      "service.name": this.serviceName,
      "kvdock.event.type": event.type,
      "kvdock.key": event.key ?? "unknown",
      "kvdock.timestamp": event.timestamp,
      ...this.defaultAttributes,
      ...(event.meta ?? {}),
    };

    if (eventParentContext) {
      attributes["kvdock.trace_id"] = eventParentContext.traceId;
      attributes["kvdock.parent.span_id"] = eventParentContext.spanId;
      if (eventParentContext.isRemote) {
        attributes["kvdock.parent.is_remote"] = true;
      }
      if (eventParentContext.traceState) {
        attributes["kvdock.tracestate"] = eventParentContext.traceState;
      }
    }

    const spanOptions: SpanOptionsLike = {
      attributes,
      ...(eventParentContext ? { parent: eventParentContext } : {}),
    };

    const span = this.tracer.startSpan(spanName, spanOptions);

    if (event.type === "hit") {
      span.setAttribute("kvdock.cache.status", "hit");
    } else if (event.type === "miss") {
      span.setAttribute("kvdock.cache.status", "miss");
    } else if (event.type === "stampede_coalesced") {
      span.setAttribute("kvdock.stampede.coalesced", true);
    }

    span.end();
  }

  public async traceOperation<T>(
    operationName: string,
    key: string,
    fn: (span?: SpanLike, context?: SpanContext) => Promise<T>,
    options?: TraceOperationOptions,
  ): Promise<T>;
  public async traceOperation<T>(
    operationName: string,
    key: string,
    options: TraceOperationOptions,
    fn: (span?: SpanLike, context?: SpanContext) => Promise<T>,
  ): Promise<T>;
  public async traceOperation<T>(
    operationName: string,
    key: string,
    fnOrOptions: ((span?: SpanLike, context?: SpanContext) => Promise<T>) | TraceOperationOptions,
    maybeFnOrOptions?:
      | ((span?: SpanLike, context?: SpanContext) => Promise<T>)
      | TraceOperationOptions,
  ): Promise<T> {
    let fn: (span?: SpanLike, context?: SpanContext) => Promise<T>;
    let options: TraceOperationOptions;

    if (typeof fnOrOptions === "function") {
      fn = fnOrOptions;
      options = (maybeFnOrOptions as TraceOperationOptions) ?? {};
    } else {
      options = fnOrOptions;
      fn = maybeFnOrOptions as (span?: SpanLike, context?: SpanContext) => Promise<T>;
    }

    let parentContext: SpanContext | undefined;
    if (options.parentContext) {
      const maybeSpan = options.parentContext as SpanLike;
      if (typeof maybeSpan.spanContext === "function") {
        parentContext = maybeSpan.spanContext();
      } else {
        parentContext = options.parentContext as SpanContext;
      }
    } else if (options.carrier) {
      parentContext = this.extractContext(options.carrier);
    } else if (this.activeSpanContext) {
      parentContext = this.activeSpanContext;
    }

    const context: SpanContext = {
      traceId: parentContext?.traceId ?? generateTraceId(),
      spanId: generateSpanId(),
      traceFlags: parentContext?.traceFlags ?? 1,
      traceState: parentContext?.traceState,
      isRemote: false,
    };

    if (options.injectCarrier) {
      this.injectContext(options.injectCarrier, context);
      if (options.baggage) {
        this.injectBaggage(options.injectCarrier, options.baggage);
      }
    }

    if (!this.tracer) {
      const prevContext = this.activeSpanContext;
      this.activeSpanContext = context;
      try {
        return await fn(undefined, context);
      } finally {
        this.activeSpanContext = prevContext;
      }
    }

    const spanAttributes: Record<string, unknown> = {
      "service.name": this.serviceName,
      "kvdock.op": operationName,
      "kvdock.key": key,
      "db.system": "kvdock",
      "db.operation": operationName,
      "kvdock.trace_id": context.traceId,
      "kvdock.span_id": context.spanId,
      ...this.defaultAttributes,
      ...(options.attributes ?? {}),
    };

    if (parentContext) {
      spanAttributes["kvdock.parent.span_id"] = parentContext.spanId;
      if (parentContext.isRemote) {
        spanAttributes["kvdock.parent.is_remote"] = true;
      }
      if (parentContext.traceState) {
        spanAttributes["kvdock.tracestate"] = parentContext.traceState;
      }
    }

    const spanOptions: SpanOptionsLike = {
      attributes: spanAttributes,
      ...(parentContext ? { parent: parentContext } : {}),
    };

    const span = this.tracer.startSpan(`kvdock.op.${operationName}`, spanOptions);
    const resolvedContext = span.spanContext?.() ?? context;

    const prevContext = this.activeSpanContext;
    this.activeSpanContext = resolvedContext;

    try {
      const result = await fn(span, resolvedContext);
      span.setStatus({ code: 1 }); // OK
      return result;
    } catch (err: unknown) {
      span.setStatus({
        code: 2, // ERROR
        message: err instanceof Error ? err.message : String(err),
      });
      if (err instanceof Error) {
        span.recordException(err);
      }
      throw err;
    } finally {
      span.end();
      this.activeSpanContext = prevContext;
    }
  }

  public wrapAdapter(adapter: StorageAdapter, options: WrapAdapterOptions = {}): StorageAdapter {
    const plugin = this;

    const wrapped: StorageAdapter = {
      name: adapter.name,
      capabilities: adapter.capabilities,

      async get<T = unknown>(key: string): Promise<T | null> {
        return plugin.traceOperation(
          "get",
          key,
          async () => {
            return adapter.get<T>(key);
          },
          { carrier: options.carrierGetter?.() },
        );
      },

      async set<T = unknown>(key: string, value: T, setOptions?: SetOptions): Promise<void> {
        return plugin.traceOperation(
          "set",
          key,
          async () => {
            return adapter.set<T>(key, value, setOptions);
          },
          { carrier: options.carrierGetter?.() },
        );
      },

      async delete(key: string): Promise<boolean> {
        return plugin.traceOperation(
          "delete",
          key,
          async () => {
            return adapter.delete(key);
          },
          { carrier: options.carrierGetter?.() },
        );
      },

      async has(key: string): Promise<boolean> {
        return plugin.traceOperation(
          "has",
          key,
          async () => {
            return adapter.has(key);
          },
          { carrier: options.carrierGetter?.() },
        );
      },

      async clear(): Promise<void> {
        return plugin.traceOperation(
          "clear",
          "*",
          async () => {
            return adapter.clear();
          },
          { carrier: options.carrierGetter?.() },
        );
      },

      async keys(pattern?: string): Promise<string[]> {
        return plugin.traceOperation(
          "keys",
          pattern ?? "*",
          async () => {
            return adapter.keys(pattern);
          },
          { carrier: options.carrierGetter?.() },
        );
      },
    };

    const origGetMany = adapter.getMany?.bind(adapter);
    if (origGetMany) {
      wrapped.getMany = async <T = unknown>(keys: string[]): Promise<Map<string, T | null>> => {
        return plugin.traceOperation(
          "getMany",
          keys.join(","),
          async () => {
            return origGetMany<T>(keys);
          },
          { carrier: options.carrierGetter?.() },
        );
      };
    }

    const origSetMany = adapter.setMany?.bind(adapter);
    if (origSetMany) {
      wrapped.setMany = async <T = unknown>(
        entries: Array<{ key: string; value: T; options?: SetOptions }>,
      ): Promise<void> => {
        return plugin.traceOperation(
          "setMany",
          entries.map((e) => e.key).join(","),
          async () => {
            return origSetMany<T>(entries);
          },
          { carrier: options.carrierGetter?.() },
        );
      };
    }

    const origDeleteMany = adapter.deleteMany?.bind(adapter);
    if (origDeleteMany) {
      wrapped.deleteMany = async (keys: string[]): Promise<number> => {
        return plugin.traceOperation(
          "deleteMany",
          keys.join(","),
          async () => {
            return origDeleteMany(keys);
          },
          { carrier: options.carrierGetter?.() },
        );
      };
    }

    const origCas = adapter.compareAndSwap?.bind(adapter);
    if (origCas) {
      wrapped.compareAndSwap = async <T = unknown>(
        key: string,
        expected: T | null,
        update: T,
        setOptions?: SetOptions,
      ): Promise<boolean> => {
        return plugin.traceOperation(
          "compareAndSwap",
          key,
          async () => {
            return origCas<T>(key, expected, update, setOptions);
          },
          { carrier: options.carrierGetter?.() },
        );
      };
    }

    const origScan = adapter.scan?.bind(adapter);
    if (origScan) {
      wrapped.scan = (pattern?: string, scanOptions?: ScanOptions) => {
        return origScan(pattern, scanOptions);
      };
    }

    const origDisconnect = adapter.disconnect?.bind(adapter);
    if (origDisconnect) {
      wrapped.disconnect = async () => {
        return origDisconnect();
      };
    }

    return wrapped;
  }
}

export function createOpenTelemetryPlugin(
  options: OpenTelemetryPluginOptions = {},
): KVDockOpenTelemetryPlugin {
  return new KVDockOpenTelemetryPlugin(options);
}
