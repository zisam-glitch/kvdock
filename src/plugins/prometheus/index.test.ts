import { describe, expect, it } from "vitest";
import { MemoryAdapter } from "../../adapters/memory/index.js";
import { KVDock } from "../../core/store.js";
import { createPrometheusPlugin, createPrometheusScrapeHandler } from "./index.js";

describe("KVDockPrometheusPlugin", () => {
  it("tracks events and formats valid prometheus exposition text", () => {
    const plugin = createPrometheusPlugin({ labels: { app: "store-service" } });

    plugin.onEvent({ type: "hit", timestamp: Date.now() });
    plugin.onEvent({ type: "hit", timestamp: Date.now() });
    plugin.onEvent({ type: "miss", timestamp: Date.now() });
    plugin.onEvent({ type: "stampede_coalesced", timestamp: Date.now() });
    plugin.onEvent({
      type: "cas",
      meta: { success: true },
      timestamp: Date.now(),
    });

    const metrics = plugin.getMetrics();
    expect(metrics).toContain('kvdock_operations_total{app="store-service",op="hit"} 2');
    expect(metrics).toContain('kvdock_operations_total{app="store-service",op="miss"} 1');
    expect(metrics).toContain('kvdock_stampede_coalesced_total{app="store-service"} 1');
    expect(metrics).toContain(
      'kvdock_operations_total{app="store-service",op="cas",status="success"} 1',
    );
    expect(metrics).toContain('kvdock_hit_ratio{app="store-service"} 0.6667');
  });

  it("escapes special characters in label values", () => {
    const plugin = createPrometheusPlugin({
      labels: {
        quote: 'val"ue',
        backslash: "a\\b",
      },
    });

    plugin.onEvent({ type: "hit", timestamp: Date.now() });
    const metrics = plugin.getMetrics();
    expect(metrics).toContain(
      'kvdock_operations_total{quote="val\\"ue",backslash="a\\\\b",op="hit"} 1',
    );
  });

  it("records latency histograms from event durationMs", () => {
    const plugin = createPrometheusPlugin({
      histogramBuckets: [0.005, 0.01, 0.05, 0.1],
    });

    // 2ms (0.002s), 8ms (0.008s), 20ms (0.020s)
    plugin.onEvent({
      type: "hit",
      meta: { durationMs: 2 },
      timestamp: Date.now(),
    });
    plugin.onEvent({
      type: "hit",
      meta: { durationMs: 8 },
      timestamp: Date.now(),
    });
    plugin.onEvent({
      type: "hit",
      meta: { durationMs: 20 },
      timestamp: Date.now(),
    });

    const metrics = plugin.getMetrics();
    expect(metrics).toContain(
      "# HELP kvdock_operation_duration_seconds Latency of kvdock operations in seconds",
    );
    expect(metrics).toContain("# TYPE kvdock_operation_duration_seconds histogram");

    // 2ms <= 0.005 (1)
    expect(metrics).toContain('kvdock_operation_duration_seconds_bucket{op="hit",le="0.005"} 1');
    // 2ms, 8ms <= 0.01 (2)
    expect(metrics).toContain('kvdock_operation_duration_seconds_bucket{op="hit",le="0.01"} 2');
    // 2ms, 8ms, 20ms <= 0.05 (3)
    expect(metrics).toContain('kvdock_operation_duration_seconds_bucket{op="hit",le="0.05"} 3');
    // <= +Inf (3)
    expect(metrics).toContain('kvdock_operation_duration_seconds_bucket{op="hit",le="+Inf"} 3');
    expect(metrics).toContain('kvdock_operation_duration_seconds_count{op="hit"} 3');
    expect(metrics).toContain('kvdock_operation_duration_seconds_sum{op="hit"} 0.030000');
  });

  it("measures asynchronous execution via measure() helper", async () => {
    const plugin = createPrometheusPlugin();

    const result = await plugin.measure("custom_compute", async () => {
      await new Promise((r) => setTimeout(r, 10));
      return 42;
    });

    expect(result).toBe(42);
    const metrics = plugin.getMetrics();
    expect(metrics).toContain('kvdock_operation_duration_seconds_count{op="custom_compute"} 1');
  });

  it("resets metrics counters and histograms", () => {
    const plugin = createPrometheusPlugin();
    plugin.onEvent({
      type: "set",
      meta: { durationMs: 5 },
      timestamp: Date.now(),
    });
    plugin.reset();

    const metrics = plugin.getMetrics();
    expect(metrics).toContain('kvdock_operations_total{op="set"} 0');
    expect(metrics).not.toContain("kvdock_operation_duration_seconds_count");
  });

  describe("Scraping HTTP Endpoint Handlers", () => {
    it("serves metrics via Web Standard Fetch handler", async () => {
      const plugin = createPrometheusPlugin({ path: "/metrics" });
      plugin.onEvent({ type: "hit", timestamp: Date.now() });

      // Valid GET
      const getReq = new Request("http://localhost:8080/metrics", {
        method: "GET",
      });
      const res = plugin.handler(getReq);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/plain; version=0.0.4; charset=utf-8");
      const text = await res.text();
      expect(text).toContain('kvdock_operations_total{op="hit"} 1');

      // Valid HEAD
      const headReq = new Request("http://localhost:8080/metrics", {
        method: "HEAD",
      });
      const headRes = plugin.handler(headReq);
      expect(headRes.status).toBe(200);
      const headBody = await headRes.text();
      expect(headBody).toBe("");

      // Invalid Method POST -> 405
      const postReq = new Request("http://localhost:8080/metrics", {
        method: "POST",
      });
      const postRes = plugin.handler(postReq);
      expect(postRes.status).toBe(405);

      // Wrong Path -> 404
      const wrongReq = new Request("http://localhost:8080/wrong-path", {
        method: "GET",
      });
      const wrongRes = plugin.handler(wrongReq);
      expect(wrongRes.status).toBe(404);
    });

    it("serves metrics via createPrometheusScrapeHandler helper", async () => {
      const plugin = createPrometheusPlugin();
      plugin.onEvent({ type: "miss", timestamp: Date.now() });

      const handler = createPrometheusScrapeHandler(plugin, {
        path: "/custom-metrics",
      });
      const res = handler(new Request("http://localhost/custom-metrics", { method: "GET" }));
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('kvdock_operations_total{op="miss"} 1');
    });

    it("handles Node HTTP request/response interfaces", () => {
      const plugin = createPrometheusPlugin({ path: "/metrics" });
      plugin.onEvent({ type: "set", timestamp: Date.now() });

      let statusCode = 0;
      let headers: Record<string, string> = {};
      let body = "";

      const mockRes = {
        writeHead: (code: number, hdrs: Record<string, string>) => {
          statusCode = code;
          headers = hdrs;
        },
        end: (chunk?: string) => {
          if (chunk) body = chunk;
        },
      };

      // Valid Node GET
      plugin.handleNodeRequest({ method: "GET", url: "/metrics" }, mockRes);
      expect(statusCode).toBe(200);
      expect(headers["Content-Type"]).toBe("text/plain; version=0.0.4; charset=utf-8");
      expect(body).toContain('kvdock_operations_total{op="set"} 1');

      // Method not allowed
      plugin.handleNodeRequest({ method: "PUT", url: "/metrics" }, mockRes);
      expect(statusCode).toBe(405);

      // Path not found
      plugin.handleNodeRequest({ method: "GET", url: "/not-found" }, mockRes);
      expect(statusCode).toBe(404);
    });

    it("spins up standalone HTTP scraping server on dedicated port", async () => {
      const plugin = createPrometheusPlugin();
      plugin.onEvent({
        type: "hit",
        meta: { durationMs: 4.2 },
        timestamp: Date.now(),
      });

      const scrapeServer = await plugin.serveScrapeEndpoint({
        port: 0,
        path: "/metrics",
      });
      try {
        expect(scrapeServer.port).toBeGreaterThan(0);
        expect(scrapeServer.url).toContain(`:${scrapeServer.port}/metrics`);

        const res = await fetch(scrapeServer.url);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/plain; version=0.0.4");
        const text = await res.text();
        expect(text).toContain('kvdock_operations_total{op="hit"} 1');
        expect(text).toContain('kvdock_operation_duration_seconds_count{op="hit"} 1');
      } finally {
        await scrapeServer.close();
      }
    });
  });

  describe("Integration with Store", () => {
    it("automatically collects operation counters and latency histograms from Store events", async () => {
      const plugin = createPrometheusPlugin({
        prefix: "myapp_cache_",
        labels: { env: "test" },
      });

      const adapter = new MemoryAdapter();
      const store = new KVDock({
        adapter,
        onEvent: (evt) => plugin.onEvent(evt),
      });

      await store.set("user:100", { name: "Zisam" });
      const val = await store.get("user:100");
      expect(val).toEqual({ name: "Zisam" });

      await store.get("user:non_existent");
      await store.compareAndSwap("user:100", { name: "Zisam" }, { name: "Zisam S." });
      await store.delete("user:100");
      await store.clear();

      const metrics = plugin.getMetrics();
      expect(metrics).toContain('myapp_cache_operations_total{env="test",op="set"} 1');
      expect(metrics).toContain('myapp_cache_operations_total{env="test",op="hit"} 1');
      expect(metrics).toContain('myapp_cache_operations_total{env="test",op="miss"} 1');
      expect(metrics).toContain(
        'myapp_cache_operations_total{env="test",op="cas",status="success"} 1',
      );
      expect(metrics).toContain('myapp_cache_operations_total{env="test",op="delete"} 1');

      // Latency histograms recorded for operations
      expect(metrics).toContain(
        'myapp_cache_operation_duration_seconds_count{env="test",op="set"} 1',
      );
      expect(metrics).toContain(
        'myapp_cache_operation_duration_seconds_count{env="test",op="hit"} 1',
      );
      expect(metrics).toContain(
        'myapp_cache_operation_duration_seconds_count{env="test",op="miss"} 1',
      );
    });
  });
});
