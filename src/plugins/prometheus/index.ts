import type { KVDockEvent } from "../../core/types.js";

export interface PrometheusPluginOptions {
  prefix?: string;
  labels?: Record<string, string>;
}

export class KVDockPrometheusPlugin {
  private readonly prefix: string;
  private readonly defaultLabels: Record<string, string>;

  private hits = 0;
  private misses = 0;
  private sets = 0;
  private deletes = 0;
  private casSuccess = 0;
  private casFailure = 0;
  private stampedeCoalesced = 0;

  constructor(options: PrometheusPluginOptions = {}) {
    this.prefix = options.prefix ?? "kvdock_";
    this.defaultLabels = options.labels ?? {};
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
  }

  private formatLabels(extra: Record<string, string> = {}): string {
    const combined = { ...this.defaultLabels, ...extra };
    const keys = Object.keys(combined);
    if (keys.length === 0) return "";
    const pairs = keys.map((k) => `${k}="${combined[k]}"`).join(",");
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
  }
}

export function createPrometheusPlugin(
  options: PrometheusPluginOptions = {},
): KVDockPrometheusPlugin {
  return new KVDockPrometheusPlugin(options);
}
