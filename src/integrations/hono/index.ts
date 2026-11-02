import crypto from "node:crypto";
import type { StorageAdapter } from "../../core/types.js";

export interface HonoLikeRequest {
  readonly method: string;
  readonly url: string;
  header(name: string): string | undefined;
}

export interface HonoLikeContext {
  readonly req: HonoLikeRequest;
  res: Response;
  header(name: string, value: string): void;
  status(code: number): void;
}

export interface HonoCacheOptions {
  adapter: StorageAdapter;
  ttl?: number;
  keyGenerator?: (c: HonoLikeContext) => string;
  etag?: boolean;
  vary?: string[];
  cacheControl?: string | ((c: HonoLikeContext) => string);
}

interface CachedResponseEnvelope {
  status: number;
  headers: Record<string, string>;
  body: string;
  etag: string;
}

export function kvdockHonoCache(options: HonoCacheOptions) {
  const { adapter, ttl = 60, etag: enableEtag = true, vary = [], cacheControl } = options;

  const defaultKeyGen = (c: HonoLikeContext): string => {
    const base = `${c.req.method}:${c.req.url}`;
    if (vary.length === 0) return base;
    const varySuffix = vary.map((header) => `${header}=${c.req.header(header) ?? ""}`).join(";");
    return `${base}|${varySuffix}`;
  };

  const keyGen = options.keyGenerator ?? defaultKeyGen;

  return async function cacheMiddleware(
    c: HonoLikeContext,
    next: () => Promise<void>,
  ): Promise<Response | undefined> {
    // Only cache idempotent GET and HEAD requests
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      await next();
      return undefined;
    }

    const cacheKey = `hono:cache:${keyGen(c)}`;
    const raw = await adapter.get<string>(cacheKey);

    if (raw) {
      try {
        const cached: CachedResponseEnvelope =
          typeof raw === "string" ? JSON.parse(raw) : (raw as CachedResponseEnvelope);

        // Check If-None-Match for conditional 304 response
        const ifNoneMatch = c.req.header("if-none-match");
        if (enableEtag && ifNoneMatch && ifNoneMatch === cached.etag) {
          return new Response(null, {
            status: 304,
            headers: {
              ETag: cached.etag,
              "X-Cache": "HIT-REVALIDATED",
            },
          });
        }

        const headers = new Headers(cached.headers);
        headers.set("X-Cache", "HIT");
        if (enableEtag) {
          headers.set("ETag", cached.etag);
        }

        const body = c.req.method === "HEAD" ? null : cached.body;
        return new Response(body, {
          status: cached.status,
          headers,
        });
      } catch {
        // Fall back to executing handler if cache envelope is corrupted
      }
    }

    await next();

    // Cache successful 200 responses
    if (c.res && c.res.status === 200) {
      const cloned = c.res.clone();
      const body = await cloned.text();
      const computedEtag = `W/"${crypto.createHash("sha1").update(body).digest("hex")}"`;

      const headersToStore: Record<string, string> = {};
      cloned.headers.forEach((val, key) => {
        headersToStore[key] = val;
      });

      if (cacheControl) {
        const ccVal = typeof cacheControl === "function" ? cacheControl(c) : cacheControl;
        headersToStore["cache-control"] = ccVal;
        c.header("cache-control", ccVal);
      }

      if (enableEtag) {
        headersToStore.etag = computedEtag;
        c.header("etag", computedEtag);
      }
      c.header("x-cache", "MISS");

      const envelope: CachedResponseEnvelope = {
        status: cloned.status,
        headers: headersToStore,
        body,
        etag: computedEtag,
      };

      await adapter.set(cacheKey, JSON.stringify(envelope), { ttl });
    }
    return undefined;
  };
}
