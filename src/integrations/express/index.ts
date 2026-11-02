import { EventEmitter } from "node:events";
import type { StorageAdapter } from "../../core/types.js";

export interface SessionData {
  cookie?: {
    originalMaxAge?: number | null;
    maxAge?: number | null;
    signed?: boolean;
    expires?: Date | string | boolean | null;
    httpOnly?: boolean;
    path?: string;
    domain?: string;
    secure?: boolean | "auto";
    sameSite?: boolean | "lax" | "strict" | "none";
  };
  [key: string]: unknown;
}

export interface ExpressSessionStoreOptions {
  adapter: StorageAdapter;
  prefix?: string;
  ttl?: number;
  disableTouch?: boolean;
}

export class KVDockExpressStore extends EventEmitter {
  private readonly adapter: StorageAdapter;
  private readonly prefix: string;
  private readonly defaultTTL: number;
  private readonly disableTouch: boolean;

  constructor(options: ExpressSessionStoreOptions) {
    super();
    if (!options?.adapter) {
      throw new Error("KVDockExpressStore requires a storage adapter");
    }
    this.adapter = options.adapter;
    this.prefix = options.prefix ?? "sess:";
    this.defaultTTL = options.ttl ?? 86400; // 1 day
    this.disableTouch = options.disableTouch ?? false;
  }

  private sessionKey(sid: string): string {
    return `${this.prefix}${sid}`;
  }

  private getTTL(sess: SessionData): number {
    if (typeof sess?.cookie?.maxAge === "number") {
      return Math.ceil(sess.cookie.maxAge / 1000);
    }
    if (
      sess?.cookie?.expires &&
      (typeof sess.cookie.expires === "string" || sess.cookie.expires instanceof Date)
    ) {
      const expTime = new Date(sess.cookie.expires).getTime();
      const remaining = Math.ceil((expTime - Date.now()) / 1000);
      return remaining > 0 ? remaining : 1;
    }
    return this.defaultTTL;
  }

  public get(
    sid: string,
    callback: (err?: Error | null, session?: SessionData | null) => void,
  ): void {
    const key = this.sessionKey(sid);
    this.adapter
      .get<string>(key)
      .then((raw) => {
        if (!raw) {
          return callback(null, null);
        }
        try {
          const parsed: SessionData =
            typeof raw === "string" ? JSON.parse(raw) : (raw as SessionData);
          callback(null, parsed);
        } catch (err: unknown) {
          const error = err instanceof Error ? err : new Error(String(err));
          callback(error);
        }
      })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        callback(error);
      });
  }

  public set(sid: string, session: SessionData, callback?: (err?: Error | null) => void): void {
    const key = this.sessionKey(sid);
    const ttl = this.getTTL(session);

    let serialized: string;
    try {
      serialized = JSON.stringify(session);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (callback) callback(error);
      return;
    }

    this.adapter
      .set(key, serialized, { ttl })
      .then(() => {
        if (callback) callback(null);
      })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        if (callback) callback(error);
      });
  }

  public destroy(sid: string, callback?: (err?: Error | null) => void): void {
    const key = this.sessionKey(sid);
    this.adapter
      .delete(key)
      .then(() => {
        if (callback) callback(null);
      })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        if (callback) callback(error);
      });
  }

  public touch(sid: string, session: SessionData, callback?: (err?: Error | null) => void): void {
    if (this.disableTouch) {
      if (callback) callback(null);
      return;
    }
    this.set(sid, session, callback);
  }

  public all(
    callback: (err?: Error | null, sessions?: Record<string, SessionData> | null) => void,
  ): void {
    const pattern = `${this.prefix}*`;
    this.adapter
      .keys(pattern)
      .then(async (matchedKeys) => {
        const result: Record<string, SessionData> = {};
        for (const k of matchedKeys) {
          const sid = k.startsWith(this.prefix) ? k.slice(this.prefix.length) : k;
          const raw = await this.adapter.get<string>(k);
          if (raw) {
            try {
              result[sid] = JSON.parse(String(raw));
            } catch {
              // skip unparseable
            }
          }
        }
        callback(null, result);
      })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        callback(error);
      });
  }

  public length(callback: (err?: Error | null, len?: number) => void): void {
    this.adapter
      .keys(`${this.prefix}*`)
      .then((keys) => {
        callback(null, keys.length);
      })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        callback(error);
      });
  }

  public clear(callback?: (err?: Error | null) => void): void {
    this.adapter
      .keys(`${this.prefix}*`)
      .then(async (keys) => {
        for (const k of keys) {
          await this.adapter.delete(k);
        }
        if (callback) callback(null);
      })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        if (callback) callback(error);
      });
  }
}
