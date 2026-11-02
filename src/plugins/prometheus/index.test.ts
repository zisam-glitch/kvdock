import { describe, expect, it } from "vitest";
import { createPrometheusPlugin } from "./index.js";

describe("KVDockPrometheusPlugin", () => {
  it("tracks events and formats valid prometheus exposition text", () => {
    const plugin = createPrometheusPlugin({ labels: { app: "store-service" } });

    plugin.onEvent({ type: "hit", timestamp: Date.now() });
    plugin.onEvent({ type: "hit", timestamp: Date.now() });
    plugin.onEvent({ type: "miss", timestamp: Date.now() });
    plugin.onEvent({ type: "stampede_coalesced", timestamp: Date.now() });
    plugin.onEvent({ type: "cas", meta: { success: true }, timestamp: Date.now() });

    const metrics = plugin.getMetrics();
    expect(metrics).toContain('kvdock_operations_total{app="store-service",op="hit"} 2');
    expect(metrics).toContain('kvdock_operations_total{app="store-service",op="miss"} 1');
    expect(metrics).toContain('kvdock_stampede_coalesced_total{app="store-service"} 1');
    expect(metrics).toContain(
      'kvdock_operations_total{app="store-service",op="cas",status="success"} 1',
    );
    expect(metrics).toContain('kvdock_hit_ratio{app="store-service"} 0.6667');
  });

  it("resets metrics counters", () => {
    const plugin = createPrometheusPlugin();
    plugin.onEvent({ type: "set", timestamp: Date.now() });
    plugin.reset();

    const metrics = plugin.getMetrics();
    expect(metrics).toContain('kvdock_operations_total{op="set"} 0');
  });
});
