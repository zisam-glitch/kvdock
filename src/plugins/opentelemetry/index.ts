import type { KVDockEvent } from "../../core/types.js";

export interface SpanLike {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(status: { code: number; message?: string }): void;
  recordException(exception: Error): void;
  end(): void;
}

export interface TracerLike {
  startSpan(name: string, options?: { attributes?: Record<string, unknown> }): SpanLike;
}

export interface OpenTelemetryPluginOptions {
  tracer?: TracerLike;
  serviceName?: string;
  recordHitsAndMisses?: boolean;
}

export class KVDockOpenTelemetryPlugin {
  private readonly tracer?: TracerLike;
  private readonly serviceName: string;
  private readonly recordHitsAndMisses: boolean;

  constructor(options: OpenTelemetryPluginOptions = {}) {
    this.tracer = options.tracer;
    this.serviceName = options.serviceName ?? "kvdock";
    this.recordHitsAndMisses = options.recordHitsAndMisses ?? true;
  }

  public onEvent(event: KVDockEvent): void {
    if (!this.tracer) return;

    if (!this.recordHitsAndMisses && (event.type === "hit" || event.type === "miss")) {
      return;
    }

    const spanName = `kvdock.${event.type}`;
    const span = this.tracer.startSpan(spanName, {
      attributes: {
        "service.name": this.serviceName,
        "kvdock.event.type": event.type,
        "kvdock.key": event.key ?? "unknown",
        "kvdock.timestamp": event.timestamp,
        ...(event.meta ?? {}),
      },
    });

    if (event.type === "hit") {
      span.setAttribute("kvdock.cache.status", "hit");
    } else if (event.type === "miss") {
      span.setAttribute("kvdock.cache.status", "miss");
    } else if (event.type === "stampede_coalesced") {
      span.setAttribute("kvdock.stampede.coalesced", true);
    }

    span.end();
  }

  public traceOperation<T>(
    operationName: string,
    key: string,
    fn: (span?: SpanLike) => Promise<T>,
  ): Promise<T> {
    if (!this.tracer) {
      return fn();
    }

    const span = this.tracer.startSpan(`kvdock.op.${operationName}`, {
      attributes: {
        "service.name": this.serviceName,
        "kvdock.op": operationName,
        "kvdock.key": key,
      },
    });

    return fn(span)
      .then((result) => {
        span.setStatus({ code: 1 }); // OK
        span.end();
        return result;
      })
      .catch((err: unknown) => {
        span.setStatus({
          code: 2, // ERROR
          message: err instanceof Error ? err.message : String(err),
        });
        if (err instanceof Error) {
          span.recordException(err);
        }
        span.end();
        throw err;
      });
  }
}

export function createOpenTelemetryPlugin(
  options: OpenTelemetryPluginOptions = {},
): KVDockOpenTelemetryPlugin {
  return new KVDockOpenTelemetryPlugin(options);
}
