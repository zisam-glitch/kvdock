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
  set?: (key: string, value: unknown) => void;
  get?: (key: string) => unknown;
}

export interface HonoCacheOptions {
  adapter?: StorageAdapter;
  dock?: StorageAdapter;
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
  const adapter = options.dock ?? options.adapter;
  if (!adapter) {
    throw new Error("kvdockHonoCache requires either 'dock' or 'adapter' option.");
  }

  const { ttl = 60, etag: enableEtag = true, vary = [], cacheControl } = options;

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
      return;
    }

    const cacheKey = `hono:cache:${keyGen(c)}`;
    const raw = await adapter.get<string | CachedResponseEnvelope>(cacheKey);

    if (raw) {
      try {
        const cached: CachedResponseEnvelope = typeof raw === "string" ? JSON.parse(raw) : raw;

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

export const cacheMiddleware = kvdockHonoCache;

export interface HonoSessionCookieOptions {
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
  domain?: string;
}

export interface HonoSessionOptions {
  adapter?: StorageAdapter;
  dock?: StorageAdapter;
  cookieName?: string;
  ttl?: number; // seconds
  prefix?: string;
  cookieOptions?: HonoSessionCookieOptions;
}

export interface SessionStore {
  id: string;
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  entries(): Record<string, unknown>;
  destroy(): Promise<void>;
  regenerate(): Promise<void>;
}

function parseCookies(headerValue?: string): Record<string, string> {
  if (!headerValue) return {};
  const cookies: Record<string, string> = {};
  for (const pair of headerValue.split(";")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    cookies[key] = decodeURIComponent(val);
  }
  return cookies;
}

function serializeCookie(
  name: string,
  value: string,
  opts: HonoSessionCookieOptions & { maxAge?: number } = {},
): string {
  let cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
  cookie += `; Path=${opts.path ?? "/"}`;
  if (opts.httpOnly !== false) cookie += "; HttpOnly";
  if (opts.secure) cookie += "; Secure";
  if (opts.sameSite) cookie += `; SameSite=${opts.sameSite}`;
  else cookie += "; SameSite=Lax";
  if (opts.domain) cookie += `; Domain=${opts.domain}`;
  if (typeof opts.maxAge === "number") cookie += `; Max-Age=${opts.maxAge}`;
  return cookie;
}

export function kvdockHonoSession(options: HonoSessionOptions) {
  const adapter = options.dock ?? options.adapter;
  if (!adapter) {
    throw new Error("kvdockHonoSession requires either 'dock' or 'adapter' option.");
  }

  const {
    cookieName = "kvdock_sid",
    ttl = 86400,
    prefix = "hono:session:",
    cookieOptions = {},
  } = options;

  return async function sessionMiddleware(
    c: HonoLikeContext,
    next: () => Promise<void>,
  ): Promise<void> {
    const cookies = parseCookies(c.req.header("cookie"));
    let sessionId = cookies[cookieName];
    let isNew = false;
    let isDestroyed = false;
    let isModified = false;

    let data: Record<string, unknown> = {};

    if (sessionId) {
      const stored = await adapter.get<Record<string, unknown> | string>(`${prefix}${sessionId}`);
      if (stored) {
        try {
          data = typeof stored === "string" ? JSON.parse(stored) : stored;
        } catch {
          data = {};
        }
      } else {
        sessionId = crypto.randomUUID();
        isNew = true;
      }
    } else {
      sessionId = crypto.randomUUID();
      isNew = true;
    }

    const session: SessionStore = {
      get id() {
        return sessionId;
      },
      get<T = unknown>(key: string): T | undefined {
        return data[key] as T | undefined;
      },
      set(key: string, value: unknown): void {
        data[key] = value;
        isModified = true;
      },
      delete(key: string): void {
        delete data[key];
        isModified = true;
      },
      entries(): Record<string, unknown> {
        return { ...data };
      },
      async destroy(): Promise<void> {
        isDestroyed = true;
        data = {};
        await adapter.delete(`${prefix}${sessionId}`);
      },
      async regenerate(): Promise<void> {
        if (sessionId) {
          await adapter.delete(`${prefix}${sessionId}`);
        }
        sessionId = crypto.randomUUID();
        isNew = true;
        isModified = true;
      },
    };

    if (c.set) {
      c.set("session", session);
    }

    await next();

    if (isDestroyed) {
      // Clear cookie
      const clearCookie = serializeCookie(cookieName, "", {
        ...cookieOptions,
        maxAge: 0,
      });
      c.header("set-cookie", clearCookie);
    } else if (isNew || isModified) {
      await adapter.set(`${prefix}${sessionId}`, JSON.stringify(data), { ttl });
      if (isNew) {
        const cookieStr = serializeCookie(cookieName, sessionId, {
          ...cookieOptions,
          maxAge: ttl,
        });
        c.header("set-cookie", cookieStr);
      }
    }
  };
}

export const sessionMiddleware = kvdockHonoSession;
