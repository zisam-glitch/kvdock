import crypto from "node:crypto";
import { MemoryAdapter } from "../../adapters/memory/index.js";
import type { StorageAdapter } from "../../core/types.js";

export interface SvelteKitRequestEventLike {
  request: Request;
  url: URL;
  locals: Record<string, unknown>;
  cookies?: {
    get(name: string): string | undefined;
    set(name: string, value: string, opts?: Record<string, unknown>): void;
    delete(name: string, opts?: Record<string, unknown>): void;
  };
  params?: Record<string, string>;
  route?: { id: string | null };
}

export interface SvelteKitResolveOptionsLike {
  transformPageChunk?: (input: { html: string; done: boolean }) => string | Promise<string>;
  filterSerializedResponseHeaders?: (name: string, value: string) => boolean;
  preload?: (input: { type: "js" | "css" | "asset"; path: string }) => boolean;
}

export type SvelteKitHandleLike = (input: {
  event: SvelteKitRequestEventLike;
  resolve: (
    event: SvelteKitRequestEventLike,
    opts?: SvelteKitResolveOptionsLike,
  ) => Promise<Response>;
}) => Promise<Response>;

export interface KVDockSvelteKitCacheOptions {
  adapter?: StorageAdapter;
  ttl?: number;
  prefix?: string;
  etag?: boolean;
  vary?: string[];
  keyGenerator?: (event: SvelteKitRequestEventLike) => string;
  shouldCache?: (event: SvelteKitRequestEventLike, res: Response) => boolean;
  cacheControl?: string | ((event: SvelteKitRequestEventLike) => string);
}

export interface CachedSvelteKitResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  etag: string;
}

export function createKVDockHandle(options: KVDockSvelteKitCacheOptions = {}): SvelteKitHandleLike {
  const adapter = options.adapter ?? new MemoryAdapter();
  const ttl = options.ttl ?? 60;
  const prefix = options.prefix ?? "sveltekit:cache:";
  const enableEtag = options.etag ?? true;
  const vary = options.vary ?? [];

  const defaultKeyGen = (event: SvelteKitRequestEventLike): string => {
    const base = `${event.url.pathname}${event.url.search}`;
    if (vary.length === 0) return base;
    const varySuffix = vary
      .map((header) => `${header}=${event.request.headers.get(header) ?? ""}`)
      .join(";");
    return `${base}|${varySuffix}`;
  };

  const keyGen = options.keyGenerator ?? defaultKeyGen;

  return async ({ event, resolve }) => {
    const method = event.request.method;
    if (method !== "GET" && method !== "HEAD") {
      return resolve(event);
    }

    const key = `${prefix}${keyGen(event)}`;
    const raw = await adapter.get<string | CachedSvelteKitResponse>(key);

    if (raw) {
      try {
        const cached: CachedSvelteKitResponse = typeof raw === "string" ? JSON.parse(raw) : raw;

        const ifNoneMatch = event.request.headers.get("if-none-match");
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

        return new Response(method === "HEAD" ? null : cached.body, {
          status: cached.status,
          headers,
        });
      } catch {
        // Fallback safely to fresh resolve on corrupt cache
      }
    }

    const response = await resolve(event);

    const isCacheable =
      options.shouldCache?.(event, response) ??
      (response.status === 200 &&
        !response.headers.get("cache-control")?.includes("no-store") &&
        !response.headers.get("set-cookie"));

    if (isCacheable) {
      const cloned = response.clone();
      const body = await cloned.text();
      const etag = `W/"${crypto.createHash("sha1").update(body).digest("hex")}"`;

      const headersToCache: Record<string, string> = {};
      response.headers.forEach((value, headerKey) => {
        if (headerKey.toLowerCase() !== "x-cache") {
          headersToCache[headerKey] = value;
        }
      });

      if (enableEtag) {
        headersToCache.etag = etag;
      }

      if (options.cacheControl) {
        const cc =
          typeof options.cacheControl === "function"
            ? options.cacheControl(event)
            : options.cacheControl;
        headersToCache["cache-control"] = cc;
      }

      const envelope: CachedSvelteKitResponse = {
        status: response.status,
        headers: headersToCache,
        body,
        etag,
      };

      await adapter.set(key, JSON.stringify(envelope), { ttl });

      const newHeaders = new Headers(response.headers);
      newHeaders.set("X-Cache", "MISS");
      if (enableEtag) {
        newHeaders.set("ETag", etag);
      }
      if (options.cacheControl) {
        const cc =
          typeof options.cacheControl === "function"
            ? options.cacheControl(event)
            : options.cacheControl;
        newHeaders.set("Cache-Control", cc);
      }

      return new Response(method === "HEAD" ? null : body, {
        status: response.status,
        headers: newHeaders,
      });
    }

    return response;
  };
}

export interface SvelteKitSessionOptions {
  adapter?: StorageAdapter;
  prefix?: string;
  ttl?: number;
  cookieName?: string;
}

export interface SvelteKitSessionManager<
  T extends Record<string, unknown> = Record<string, unknown>,
> {
  getSession(sessionId: string): Promise<T | null>;
  setSession(sessionId: string, data: T, ttl?: number): Promise<void>;
  destroySession(sessionId: string): Promise<void>;
  touchSession(sessionId: string, ttl?: number): Promise<void>;
  handle(event: SvelteKitRequestEventLike): Promise<{
    sessionId: string;
    data: T;
    isNew: boolean;
    save(): Promise<void>;
    destroy(): Promise<void>;
  }>;
}

export function createSvelteKitSessionStore<
  T extends Record<string, unknown> = Record<string, unknown>,
>(options: SvelteKitSessionOptions = {}): SvelteKitSessionManager<T> {
  const adapter = options.adapter ?? new MemoryAdapter();
  const prefix = options.prefix ?? "sveltekit:session:";
  const defaultTtl = options.ttl ?? 86400;
  const cookieName = options.cookieName ?? "kvdock_session";

  const keyFor = (id: string) => `${prefix}${id}`;

  return {
    async getSession(sessionId: string): Promise<T | null> {
      const raw = await adapter.get<string>(keyFor(sessionId));
      if (!raw) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    },

    async setSession(sessionId: string, data: T, ttl?: number): Promise<void> {
      const effectiveTtl = ttl ?? defaultTtl;
      await adapter.set(keyFor(sessionId), JSON.stringify(data), { ttl: effectiveTtl });
    },

    async destroySession(sessionId: string): Promise<void> {
      await adapter.delete(keyFor(sessionId));
    },

    async touchSession(sessionId: string, ttl?: number): Promise<void> {
      const data = await this.getSession(sessionId);
      if (data) {
        await this.setSession(sessionId, data, ttl);
      }
    },

    async handle(event: SvelteKitRequestEventLike) {
      let sessionId = event.cookies?.get(cookieName);
      let isNew = false;
      let data: T | null = null;

      if (sessionId) {
        data = await this.getSession(sessionId);
      }

      if (!sessionId || !data) {
        sessionId = crypto.randomUUID();
        isNew = true;
        data = {} as T;
        event.cookies?.set(cookieName, sessionId, {
          path: "/",
          httpOnly: true,
          sameSite: "lax",
          maxAge: defaultTtl,
        });
      }

      const activeSessionId = sessionId;
      const sessionData = { ...data };

      return {
        sessionId: activeSessionId,
        data: sessionData,
        isNew,
        save: async () => {
          await this.setSession(activeSessionId, sessionData, defaultTtl);
        },
        destroy: async () => {
          await this.destroySession(activeSessionId);
          event.cookies?.delete(cookieName, { path: "/" });
        },
      };
    },
  };
}
