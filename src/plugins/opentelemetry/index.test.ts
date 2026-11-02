import { describe, expect, it, vi } from "vitest";
import {
  KVDockOpenTelemetryPlugin,
  type SpanLike,
  type TracerLike,
  createOpenTelemetryPlugin,
} from "./index.js";

function createMockTracer(): {
  tracer: TracerLike;
  spans: Array<{ name: string; attrs: Record<string, unknown> }>;
} {
  const spans: Array<{ name: string; attrs: Record<string, unknown> }> = [];

  const tracer: TracerLike = {
    startSpan(name: string, options?: { attributes?: Record<string, unknown> }) {
      const attrs: Record<string, unknown> = { ...(options?.attributes ?? {}) };
      const span: SpanLike = {
        setAttribute(k, v) {
          attrs[k] = v;
        },
        setStatus() {},
        recordException() {},
        end() {
          spans.push({ name, attrs });
        },
      };
      return span;
    },
  };

  return { tracer, spans };
}

describe("KVDockOpenTelemetryPlugin", () => {
  it("creates spans on hit and miss events", () => {
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

  it("traces async operation execution and status", async () => {
    const { tracer, spans } = createMockTracer();
    const plugin = new KVDockOpenTelemetryPlugin({ tracer });

    const result = await plugin.traceOperation("getOrSet", "key1", async () => {
      return "computed_val";
    });

    expect(result).toBe("computed_val");
    expect(spans.length).toBe(1);
    expect(spans[0].name).toBe("kvdock.op.getOrSet");
    expect(spans[0].attrs["kvdock.key"]).toBe("key1");
  });

  it("records stampede coalesced events", () => {
    const { tracer, spans } = createMockTracer();
    const plugin = createOpenTelemetryPlugin({ tracer });

    plugin.onEvent({
      type: "stampede_coalesced",
      key: "hot_key",
      timestamp: Date.now(),
    });

    expect(spans.length).toBe(1);
    expect(spans[0].attrs["kvdock.stampede.coalesced"]).toBe(true);
  });
});
