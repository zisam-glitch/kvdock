import type { KVDockEvent } from "../../core/types.js";

export const DEFAULT_PROMETHEUS_HISTOGRAM_BUCKETS: readonly number[] = [
  0.001, // 1ms
  0.005, // 5ms
  0.01, // 10ms
  0.025, // 25ms
  0.05, // 50ms
  0.1, // 100ms
  0.25, // 250ms
  0.5, // 500ms
  1, // 1s
  2.5, // 2.5s
  5, // 5s
  10, // 10s
];

export interface PrometheusPluginOptions {
  prefix?: string;
  labels?: Record<string, string>;
  histogramBuckets?: number[];
  path?: string;
}

export interface PrometheusScrapeServer {
  readonly server: unknown;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

interface HistogramState {
  readonly op: string;
  readonly extraLabels: Record<string, string>;
  readonly counts: number[];
  infCount: number;
  sum: number;
  count: number;
}

export class KVDockPrometheusPlugin {
  private readonly prefix: string;
  private readonly defaultLabels: Record<string, string>;
  private readonly histogramBuckets: readonly number[];
  private readonly path?: string;

  private hits = 0;
  private misses = 0;
  private sets = 0;
  private deletes = 0;
  private casSuccess = 0;
  private casFailure = 0;
  private stampedeCoalesced = 0;

  private readonly histograms = new Map<string, HistogramState>();

  constructor(options: PrometheusPluginOptions = {}) {
    this.prefix = options.prefix ?? "kvdock_";
    this.defaultLabels = options.labels ?? {};
    this.path = options.path;

    const buckets = options.histogramBuckets ?? DEFAULT_PROMETHEUS_HISTOGRAM_BUCKETS;
    this.histogramBuckets = [...buckets].sort((a, b) => a - b);
  }

  public onEvent(event: KVDockEvent): void {
    switch (event.type) {
      case "hit":
        this.hits++;
        break;
      case "miss":
        this.misses++;
        break;
      case "set":
        this.sets++;
        break;
      case "delete":
        this.deletes++;
        break;
      case "cas":
        if (event.meta?.success) {
          this.casSuccess++;
        } else {
          this.casFailure++;
        }
        break;
      case "stampede_coalesced":
        this.stampedeCoalesced++;
        break;
    }

    if (
      event.meta &&
      typeof event.meta.durationMs === "number" &&
      !Number.isNaN(event.meta.durationMs) &&
      event.meta.durationMs >= 0
    ) {
      this.observeLatency(event.type, event.meta.durationMs / 1000);
    }
  }

  private getHistogramKey(op: string, extraLabels?: Record<string, string>): string {
    const combined: Record<string, string> = { ...this.defaultLabels, ...extraLabels, op };
    const sorted = Object.keys(combined)
      .sort()
      .map((k) => `${k}=${combined[k]}`)
      .join(",");
    return sorted;
  }

  public observeLatency(
    operation: string,
    durationSeconds: number,
    labels?: Record<string, string>,
  ): void {
    if (Number.isNaN(durationSeconds) || durationSeconds < 0) return;

    const key = this.getHistogramKey(operation, labels);
    let state = this.histograms.get(key);
    if (!state) {
      state = {
        op: operation,
        extraLabels: labels ? { ...labels } : {},
        counts: new Array(this.histogramBuckets.length).fill(0),
        infCount: 0,
        sum: 0,
        count: 0,
      };
      this.histograms.set(key, state);
    }

    state.sum += durationSeconds;
    state.count++;
    state.infCount++;

    for (let i = 0; i < this.histogramBuckets.length; i++) {
      if (durationSeconds <= this.histogramBuckets[i]) {
        state.counts[i]++;
      }
    }
  }

  public async measure<T>(
    operation: string,
    fn: () => Promise<T> | T,
    labels?: Record<string, string>,
  ): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      const durationSeconds = (performance.now() - start) / 1000;
      this.observeLatency(operation, durationSeconds, labels);
    }
  }

  private formatLabels(extra: Record<string, string> = {}): string {
    const combined = { ...this.defaultLabels, ...extra };
    const keys = Object.keys(combined);
    if (keys.length === 0) return "";
    const pairs = keys
      .map((k) => {
        const val = String(combined[k])
          .replace(/\\/g, "\\\\")
          .replace(/"/g, '\\"')
          .replace(/\n/g, "\\n");
        return `${k}="${val}"`;
      })
      .join(",");
    return `{${pairs}}`;
  }

  public getMetrics(): string {
    const p = this.prefix;
    const lines: string[] = [];

    lines.push(`# HELP ${p}operations_total Total cache operations by operation type`);
    lines.push(`# TYPE ${p}operations_total counter`);
    lines.push(`${p}operations_total${this.formatLabels({ op: "hit" })} ${this.hits}`);
    lines.push(`${p}operations_total${this.formatLabels({ op: "miss" })} ${this.misses}`);
    lines.push(`${p}operations_total${this.formatLabels({ op: "set" })} ${this.sets}`);
    lines.push(`${p}operations_total${this.formatLabels({ op: "delete" })} ${this.deletes}`);
    lines.push(
      `${p}operations_total${this.formatLabels({ op: "cas", status: "success" })} ${this.casSuccess}`,
    );
    lines.push(
      `${p}operations_total${this.formatLabels({ op: "cas", status: "failure" })} ${this.casFailure}`,
    );

    lines.push(
      `# HELP ${p}stampede_coalesced_total Total number of concurrent stampede requests coalesced`,
    );
    lines.push(`# TYPE ${p}stampede_coalesced_total counter`);
    lines.push(`${p}stampede_coalesced_total${this.formatLabels()} ${this.stampedeCoalesced}`);

    const totalRequests = this.hits + this.misses;
    const hitRatio = totalRequests > 0 ? (this.hits / totalRequests).toFixed(4) : "0.0000";

    lines.push(`# HELP ${p}hit_ratio Calculated cache hit ratio between 0.0 and 1.0`);
    lines.push(`# TYPE ${p}hit_ratio gauge`);
    lines.push(`${p}hit_ratio${this.formatLabels()} ${hitRatio}`);

    // Histograms
    if (this.histograms.size > 0) {
      lines.push(`# HELP ${p}operation_duration_seconds Latency of kvdock operations in seconds`);
      lines.push(`# TYPE ${p}operation_duration_seconds histogram`);

      for (const state of this.histograms.values()) {
        const baseLabels = { op: state.op, ...state.extraLabels };
        for (let i = 0; i < this.histogramBuckets.length; i++) {
          const le = String(this.histogramBuckets[i]);
          lines.push(
            `${p}operation_duration_seconds_bucket${this.formatLabels({ ...baseLabels, le })} ${state.counts[i]}`,
          );
        }
        lines.push(
          `${p}operation_duration_seconds_bucket${this.formatLabels({ ...baseLabels, le: "+Inf" })} ${state.infCount}`,
        );
        lines.push(
          `${p}operation_duration_seconds_sum${this.formatLabels(baseLabels)} ${state.sum.toFixed(6)}`,
        );
        lines.push(
          `${p}operation_duration_seconds_count${this.formatLabels(baseLabels)} ${state.count}`,
        );
      }
    }

    return `${lines.join("\n")}\n`;
  }

  public reset(): void {
    this.hits = 0;
    this.misses = 0;
    this.sets = 0;
    this.deletes = 0;
    this.casSuccess = 0;
    this.casFailure = 0;
    this.stampedeCoalesced = 0;
    this.histograms.clear();
  }

  /**
   * Web Standard Fetch API endpoint handler compatible with Next.js, Remix, Hono, Bun, and Cloudflare Workers.
   */
  public handler(request?: Request, pathOverride?: string): Response {
    const effectivePath = pathOverride ?? this.path;

    if (request) {
      const method = request.method ? request.method.toUpperCase() : "GET";
      if (method !== "GET" && method !== "HEAD") {
        return new Response("Method Not Allowed\n", {
          status: 405,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            Allow: "GET, HEAD",
          },
        });
      }

      if (effectivePath && request.url) {
        try {
          const url = new URL(request.url, "http://localhost");
          if (url.pathname !== effectivePath) {
            return new Response("Not Found\n", {
              status: 404,
              headers: { "Content-Type": "text/plain; charset=utf-8" },
            });
          }
        } catch {
          // ignore parsing error
        }
      }

      if (method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: {
            "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
            "Cache-Control": "no-cache, no-store, must-revalidate",
          },
        });
      }
    }

    return new Response(this.getMetrics(), {
      status: 200,
      headers: {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        "Cache-Control": "no-cache, no-store, must-revalidate",
      },
    });
  }

  /**
   * Node.js HTTP request handler compatible with Express, Fastify, Connect, and http.createServer.
   */
  public handleNodeRequest(
    req: { method?: string; url?: string },
    res: {
      writeHead: (statusCode: number, headers: Record<string, string>) => void;
      end: (data?: string) => void;
    },
    pathOverride?: string,
  ): void {
    const effectivePath = pathOverride ?? this.path;
    const method = req.method ? req.method.toUpperCase() : "GET";
    if (method !== "GET" && method !== "HEAD") {
      res.writeHead(405, {
        "Content-Type": "text/plain; charset=utf-8",
        Allow: "GET, HEAD",
      });
      res.end("Method Not Allowed\n");
      return;
    }

    if (effectivePath && req.url) {
      const pathname = req.url.split("?")[0];
      if (pathname !== effectivePath) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not Found\n");
        return;
      }
    }

    if (method === "HEAD") {
      res.writeHead(200, {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        "Cache-Control": "no-cache, no-store, must-revalidate",
      });
      res.end();
      return;
    }

    const body = this.getMetrics();
    res.writeHead(200, {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Connection: "close",
    });
    res.end(body);
  }

  /**
   * Standalone HTTP scraping server for Prometheus scrapers on dedicated port (e.g. :9090/metrics).
   */
  public async serveScrapeEndpoint(
    options: {
      port?: number;
      host?: string;
      path?: string;
    } = {},
  ): Promise<PrometheusScrapeServer> {
    const http = await import("node:http");
    const port = options.port ?? 9090;
    const host = options.host ?? "127.0.0.1";
    const serverPath = options.path ?? this.path ?? "/metrics";

    const server = http.createServer((req, res) => {
      this.handleNodeRequest(req, res, serverPath);
    });

    const sockets = new Set<{ destroy: () => void }>();
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(port, host, () => resolve());
      server.once("error", reject);
    });

    const addr = server.address();
    const actualPort = typeof addr === "object" && addr !== null ? addr.port : port;
    const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
    const url = `http://${displayHost}:${actualPort}${serverPath}`;

    return {
      server,
      port: actualPort,
      url,
      close: async () => {
        const s = server as unknown as { closeAllConnections?: () => void };
        if (typeof s.closeAllConnections === "function") {
          s.closeAllConnections();
        }
        for (const socket of sockets) {
          socket.destroy();
        }
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      },
    };
  }
}

export function createPrometheusPlugin(
  options: PrometheusPluginOptions = {},
): KVDockPrometheusPlugin {
  return new KVDockPrometheusPlugin(options);
}

export function createPrometheusScrapeHandler(
  plugin: KVDockPrometheusPlugin,
  options: { path?: string } = {},
): (request?: Request) => Response {
  return (request?: Request) => plugin.handler(request, options.path);
}
