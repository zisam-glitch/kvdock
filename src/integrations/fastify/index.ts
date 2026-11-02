import crypto from "node:crypto";
import { MemoryAdapter } from "../../adapters/memory/index.js";
import type { StorageAdapter } from "../../core/types.js";

export interface FastifyRequestLike {
  method: string;
  url: string;
  headers: Record<string, string | undefined>;
}

export interface FastifyReplyLike {
  code(statusCode: number): FastifyReplyLike;
  header(key: string, value: string): FastifyReplyLike;
  send(payload: unknown): FastifyReplyLike;
  statusCode: number;
  sent: boolean;
}

export interface FastifyInstanceLike {
  addHook(
    name: "onRequest",
    fn: (
      req: FastifyRequestLike,
      reply: FastifyReplyLike,
      done?: () => void,
    ) => Promise<void> | void,
  ): void;
  addHook(
    name: "onSend",
    fn: (
      req: FastifyRequestLike,
      reply: FastifyReplyLike,
      payload: unknown,
      done?: (err: Error | null, newPayload?: unknown) => void,
    ) => Promise<unknown> | unknown,
  ): void;
  decorate(name: string, value: unknown): void;
}

export interface FastifyCacheOptions {
  adapter?: StorageAdapter;
  ttl?: number;
  prefix?: string;
  etag?: boolean;
}

interface StoredFastifyPayload {
  statusCode: number;
  payload: string;
  etag: string;
}

export function kvdockFastifyPlugin(
  fastify: FastifyInstanceLike,
  options: FastifyCacheOptions = {},
): void {
  const adapter = options.adapter ?? new MemoryAdapter();
  const ttl = options.ttl ?? 60;
  const prefix = options.prefix ?? "fastify:cache:";
  const enableEtag = options.etag ?? true;

  fastify.decorate("kvdockAdapter", adapter);

  fastify.addHook("onRequest", async (req, reply) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return;
    }

    const key = `${prefix}${req.url}`;
    const raw = await adapter.get<string>(key);
    if (!raw) return;

    try {
      const cached: StoredFastifyPayload = JSON.parse(raw);
      const ifNoneMatch = req.headers["if-none-match"];

      if (enableEtag && ifNoneMatch && ifNoneMatch === cached.etag) {
        reply.code(304).header("ETag", cached.etag).header("X-Cache", "HIT-REVALIDATED").send("");
        return;
      }

      reply
        .code(cached.statusCode)
        .header("X-Cache", "HIT")
        .header("ETag", cached.etag)
        .send(req.method === "HEAD" ? "" : cached.payload);
    } catch {
      // safe fallback on corrupted cache
    }
  });

  fastify.addHook("onSend", async (req, reply, payload) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return payload;
    }

    if (reply.statusCode === 200 && typeof payload === "string") {
      const key = `${prefix}${req.url}`;
      const etag = `W/"${crypto.createHash("sha1").update(payload).digest("hex")}"`;

      reply.header("X-Cache", "MISS");
      if (enableEtag) {
        reply.header("ETag", etag);
      }

      const envelope: StoredFastifyPayload = {
        statusCode: reply.statusCode,
        payload,
        etag,
      };

      await adapter.set(key, JSON.stringify(envelope), { ttl });
    }

    return payload;
  });
}

export const createFastifyCachePlugin = kvdockFastifyPlugin;
