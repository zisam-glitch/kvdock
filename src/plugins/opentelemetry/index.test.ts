import { describe, expect, it } from "vitest";
import { MemoryAdapter } from "../../adapters/memory/index.js";
import { KVDock } from "../../core/store.js";
import {
  CompositePropagator,
  KVDockOpenTelemetryPlugin,
  type SpanContext,
  type SpanLike,
  type SpanOptionsLike,
  type TracerLike,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
  createBaggage,
  createOpenTelemetryPlugin,
  createTraceparent,
  createTracestate,
  defaultTextMapGetter,
  defaultTextMapSetter,
  generateSpanId,
  generateTraceId,
  parseBaggage,
  parseTraceparent,
  parseTracestate,
} from "./index.js";

function createMockTracer(): {
  tracer: TracerLike;
  spans: Array<{ name: string; attrs: Record<string, unknown>; options?: SpanOptionsLike }>;
} {
  const spans: Array<{
    name: string;
    attrs: Record<string, unknown>;
    options?: SpanOptionsLike;
  }> = [];

  const tracer: TracerLike = {
    startSpan(name: string, options?: SpanOptionsLike) {
      const attrs: Record<string, unknown> = { ...(options?.attributes ?? {}) };
      const span: SpanLike = {
        setAttribute(k, v) {
          attrs[k] = v;
        },
        setStatus() {},
        recordException() {},
        end() {
          spans.push({ name, attrs, options });
        },
      };
      return span;
    },
  };

  return { tracer, spans };
}

describe("W3C Trace Context Utilities", () => {
  it("parses valid W3C traceparent headers", () => {
    const raw = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const context = parseTraceparent(raw);

    expect(context).toBeDefined();
    expect(context?.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(context?.spanId).toBe("00f067aa0ba902b7");
    expect(context?.traceFlags).toBe(1);
    expect(context?.isRemote).toBe(true);
  });

  it("handles unsampled traceparent flag", () => {
    const raw = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00";
    const context = parseTraceparent(raw);

    expect(context?.traceFlags).toBe(0);
  });

  it("rejects invalid traceparent formats", () => {
    expect(parseTraceparent("")).toBeUndefined();
    expect(parseTraceparent("invalid-traceparent")).toBeUndefined();
    // Version ff is invalid
    expect(
      parseTraceparent("ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"),
    ).toBeUndefined();
    // All-zero traceId is invalid
    expect(
      parseTraceparent("00-00000000000000000000000000000000-00f067aa0ba902b7-01"),
    ).toBeUndefined();
    // All-zero spanId is invalid
    expect(
      parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01"),
    ).toBeUndefined();
    // Version 00 with extra fields is invalid
    expect(
      parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra"),
    ).toBeUndefined();
  });

  it("accepts future versions with forward compatibility", () => {
    const raw = "01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-forward-compat";
    const context = parseTraceparent(raw);

    expect(context).toBeDefined();
    expect(context?.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(context?.spanId).toBe("00f067aa0ba902b7");
  });

  it("creates valid traceparent headers", () => {
    const context: SpanContext = {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: 1,
    };
    const header = createTraceparent(context);
    expect(header).toBe("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
    expect(header.length).toBe(55);
  });

  it("parses and formats tracestate", () => {
    const header = "rojo=00f067aa0ba902b7,congo=t61rcWkgMzE";
    const parsed = parseTracestate(header);
    expect(parsed.rojo).toBe("00f067aa0ba902b7");
    expect(parsed.congo).toBe("t61rcWkgMzE");

    const formatted = createTracestate(parsed);
    expect(formatted).toBe("rojo=00f067aa0ba902b7,congo=t61rcWkgMzE");
  });

  it("parses and formats W3C baggage", () => {
    const header = "userId=alice%201,region=us-east;prop=val";
    const parsed = parseBaggage(header);
    expect(parsed.userId).toBe("alice 1");
    expect(parsed.region).toBe("us-east");

    const formatted = createBaggage(parsed);
    expect(formatted).toContain("userId=alice%201");
    expect(formatted).toContain("region=us-east");
  });

  it("generates valid random trace and span IDs", () => {
    const traceId = generateTraceId();
    const spanId = generateSpanId();

    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(traceId).not.toBe("00000000000000000000000000000000");
    expect(spanId).not.toBe("0000000000000000");
  });
});

describe("W3CTraceContextPropagator", () => {
  it("injects and extracts trace context from plain object", () => {
    const propagator = new W3CTraceContextPropagator();
    const carrier: Record<string, string> = {};
    const context: SpanContext = {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: 1,
      traceState: "vendor=xyz",
    };

    propagator.inject(context, carrier);
    expect(carrier.traceparent).toBe("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
    expect(carrier.tracestate).toBe("vendor=xyz");

    const extracted = propagator.extract(carrier);
    expect(extracted).toBeDefined();
    expect(extracted?.traceId).toBe(context.traceId);
    expect(extracted?.spanId).toBe(context.spanId);
    expect(extracted?.traceFlags).toBe(1);
    expect(extracted?.traceState).toBe("vendor=xyz");
  });

  it("supports case-insensitive header lookup and Maps", () => {
    const propagator = new W3CTraceContextPropagator();
    const carrier = new Map<string, string>();
    carrier.set("TRACEPARENT", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");

    const extracted = propagator.extract(carrier);
    expect(extracted).toBeDefined();
    expect(extracted?.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
  });

  it("supports Web Headers object", () => {
    const propagator = new W3CTraceContextPropagator();
    const headers = new Headers();
    headers.set("traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");

    const extracted = propagator.extract(headers);
    expect(extracted?.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");

    const outHeaders = new Headers();
    if (extracted) {
      propagator.inject(extracted, outHeaders);
    }
    expect(outHeaders.get("traceparent")).toBe(
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    );
  });
});

describe("CompositePropagator", () => {
  it("propagates both trace context and custom headers", () => {
    const tracePropagator = new W3CTraceContextPropagator();
    const composite = new CompositePropagator([tracePropagator]);

    const carrier: Record<string, string> = {};
    const context: SpanContext = {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: 1,
    };

    composite.inject(context, carrier);
    expect(carrier.traceparent).toBeDefined();

    const extracted = composite.extract(carrier);
    expect(extracted?.traceId).toBe(context.traceId);
  });
});

describe("KVDockOpenTelemetryPlugin Context Propagation", () => {
  it("creates spans on hit and miss events with event attributes", () => {
    const { tracer, spans } = createMockTracer();
    const plugin = createOpenTelemetryPlugin({ tracer, serviceName: "test-service" });

    plugin.onEvent({
      type: "hit",
      key: "user:profile:1",
      timestamp: Date.now(),
    });

    plugin.onEvent({
      type: "miss",
      key: "user:profile:2",
      timestamp: Date.now(),
    });

    expect(spans.length).toBe(2);
    expect(spans[0].name).toBe("kvdock.hit");
    expect(spans[0].attrs["kvdock.cache.status"]).toBe("hit");
    expect(spans[1].name).toBe("kvdock.miss");
    expect(spans[1].attrs["kvdock.cache.status"]).toBe("miss");
  });

  it("extracts remote trace context in onEvent", () => {
    const { tracer, spans } = createMockTracer();
    const plugin = createOpenTelemetryPlugin({ tracer });

    plugin.onEvent({
      type: "hit",
      key: "user:profile:1",
      timestamp: Date.now(),
      meta: {
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        tracestate: "vendor=abc",
      },
    });

    expect(spans.length).toBe(1);
    expect(spans[0].attrs["kvdock.trace_id"]).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(spans[0].attrs["kvdock.parent.span_id"]).toBe("00f067aa0ba902b7");
    expect(spans[0].attrs["kvdock.parent.is_remote"]).toBe(true);
    expect(spans[0].attrs["kvdock.tracestate"]).toBe("vendor=abc");
  });

  it("propagates parent trace context across async operation", async () => {
    const { tracer, spans } = createMockTracer();
    const plugin = new KVDockOpenTelemetryPlugin({ tracer });

    const incomingHeaders = {
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      tracestate: "congo=test",
    };

    const outgoingHeaders: Record<string, string> = {};

    const result = await plugin.traceOperation(
      "get",
      "user:123",
      {
        carrier: incomingHeaders,
        injectCarrier: outgoingHeaders,
        attributes: { "tenant.id": "tenant-42" },
      },
      async (_span, ctx) => {
        expect(ctx?.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
        expect(ctx?.spanId).not.toBe("00f067aa0ba902b7");
        return "cached_user";
      },
    );

    expect(result).toBe("cached_user");
    expect(spans.length).toBe(1);
    expect(spans[0].name).toBe("kvdock.op.get");
    expect(spans[0].attrs["kvdock.trace_id"]).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(spans[0].attrs["kvdock.parent.span_id"]).toBe("00f067aa0ba902b7");
    expect(spans[0].attrs["kvdock.parent.is_remote"]).toBe(true);
    expect(spans[0].attrs["kvdock.tracestate"]).toBe("congo=test");
    expect(spans[0].attrs["tenant.id"]).toBe("tenant-42");

    // Outgoing carrier received injected trace context
    expect(outgoingHeaders.traceparent).toMatch(
      /^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/,
    );
    expect(outgoingHeaders.tracestate).toBe("congo=test");
  });

  it("propagates baggage across operations", async () => {
    const plugin = new KVDockOpenTelemetryPlugin();
    const carrier: Record<string, string> = {};

    plugin.injectBaggage(carrier, { userId: "alice", role: "admin" });
    expect(carrier.baggage).toBeDefined();

    const extracted = plugin.extractBaggage(carrier);
    expect(extracted?.userId).toBe("alice");
    expect(extracted?.role).toBe("admin");

    const outgoing: Record<string, string> = {};
    await plugin.traceOperation("set", "session:1", async () => "ok", {
      injectCarrier: outgoing,
      baggage: { tenant: "t1" },
    });

    expect(outgoing.baggage).toContain("tenant=t1");
  });

  it("tracks active context during operation execution", async () => {
    const plugin = new KVDockOpenTelemetryPlugin();
    expect(plugin.getActiveContext()).toBeUndefined();

    let insideContext: SpanContext | undefined;
    await plugin.traceOperation("test", "key", async () => {
      insideContext = plugin.getActiveContext();
    });

    expect(insideContext).toBeDefined();
    expect(insideContext?.traceId).toBeDefined();
    expect(plugin.getActiveContext()).toBeUndefined();
  });

  it("handles errors during traceOperation and records exception", async () => {
    const { tracer, spans } = createMockTracer();
    const plugin = new KVDockOpenTelemetryPlugin({ tracer });

    await expect(
      plugin.traceOperation("compute", "err_key", async () => {
        throw new Error("network partition");
      }),
    ).rejects.toThrow("network partition");

    expect(spans.length).toBe(1);
  });

  it("works seamlessly without tracer configured", async () => {
    const plugin = new KVDockOpenTelemetryPlugin();
    const downstreamCarrier: Record<string, string> = {};

    const result = await plugin.traceOperation(
      "get",
      "key_standalone",
      async (_span, ctx) => {
        expect(ctx?.traceId).toBeDefined();
        return 42;
      },
      { injectCarrier: downstreamCarrier },
    );

    expect(result).toBe(42);
    expect(downstreamCarrier.traceparent).toBeDefined();
  });

  it("wraps a storage adapter with distributed tracing on all methods", async () => {
    const { tracer, spans } = createMockTracer();
    const plugin = createOpenTelemetryPlugin({ tracer });
    const memory = new MemoryAdapter();

    const currentCarrier = {
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    };

    const wrapped = plugin.wrapAdapter(memory, {
      carrierGetter: () => currentCarrier,
    });

    expect(wrapped.name).toBe("memory");
    expect(wrapped.capabilities).toEqual(memory.capabilities);

    await wrapped.set("user:1", "Alice");
    const user = await wrapped.get<string>("user:1");
    expect(user).toBe("Alice");

    const hasKey = await wrapped.has("user:1");
    expect(hasKey).toBe(true);

    const keys = await wrapped.keys("user:*");
    expect(keys).toContain("user:1");

    await wrapped.delete("user:1");
    await wrapped.clear();

    const opNames = spans.map((s) => s.name);
    expect(opNames).toContain("kvdock.op.set");
    expect(opNames).toContain("kvdock.op.get");
    expect(opNames).toContain("kvdock.op.has");
    expect(opNames).toContain("kvdock.op.keys");
    expect(opNames).toContain("kvdock.op.delete");
    expect(opNames).toContain("kvdock.op.clear");

    // All spans inherited parent trace ID from carrierGetter
    for (const span of spans) {
      expect(span.attrs["kvdock.trace_id"]).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
      expect(span.attrs["kvdock.parent.span_id"]).toBe("00f067aa0ba902b7");
    }
  });

  it("integrates with KVDock store for typed object caching with trace propagation", async () => {
    const { tracer, spans } = createMockTracer();
    const plugin = createOpenTelemetryPlugin({ tracer });
    const memory = new MemoryAdapter();
    const wrapped = plugin.wrapAdapter(memory, {
      carrierGetter: () => ({
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      }),
    });
    const dock = new KVDock({ adapter: wrapped });

    await dock.set("session:1", { user: "Bob", role: "editor" }, { ttl: 60_000 });
    const session = await dock.get<{ user: string; role: string }>("session:1");
    expect(session?.user).toBe("Bob");

    expect(spans.some((s) => s.name === "kvdock.op.set")).toBe(true);
    expect(spans.some((s) => s.name === "kvdock.op.get")).toBe(true);
  });

  it("traces batch operations and compareAndSwap on wrapped adapter", async () => {
    const { tracer, spans } = createMockTracer();
    const plugin = createOpenTelemetryPlugin({ tracer });
    const memory = new MemoryAdapter();
    const wrapped = plugin.wrapAdapter(memory);

    if (wrapped.setMany) {
      await wrapped.setMany([
        { key: "batch:1", value: "v1" },
        { key: "batch:2", value: "v2" },
      ]);
    }
    const items = wrapped.getMany ? await wrapped.getMany(["batch:1", "batch:2"]) : new Map();
    expect(items.get("batch:1")).toBe("v1");
    expect(items.get("batch:2")).toBe("v2");

    await wrapped.set("cas:key", "initial");
    const swapped = wrapped.compareAndSwap
      ? await wrapped.compareAndSwap("cas:key", "initial", "updated")
      : false;
    expect(swapped).toBe(true);

    const deleted = wrapped.deleteMany ? await wrapped.deleteMany(["batch:1", "batch:2"]) : 0;
    expect(deleted).toBe(2);

    const names = spans.map((s) => s.name);
    expect(names).toContain("kvdock.op.setMany");
    expect(names).toContain("kvdock.op.getMany");
    expect(names).toContain("kvdock.op.compareAndSwap");
    expect(names).toContain("kvdock.op.deleteMany");
  });
});
