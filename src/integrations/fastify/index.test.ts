import { beforeEach, describe, expect, it } from "vitest";
import { MemoryAdapter } from "../../adapters/memory/index.js";
import {
  type FastifyInstanceLike,
  type FastifyReplyLike,
  type FastifyRequestLike,
  kvdockFastifyPlugin,
} from "./index.js";

type MockHookFn = (...args: unknown[]) => Promise<unknown> | unknown;

function createMockFastify(): {
  fastify: FastifyInstanceLike;
  hooks: Record<string, Array<MockHookFn>>;
  decorations: Record<string, unknown>;
} {
  const hooks: Record<string, Array<MockHookFn>> = {
    onRequest: [],
    onSend: [],
  };
  const decorations: Record<string, unknown> = {};

  const fastify: FastifyInstanceLike = {
    addHook(name: "onRequest" | "onSend", fn: unknown) {
      hooks[name].push(fn as MockHookFn);
    },
    decorate(name: string, value: unknown) {
      decorations[name] = value;
    },
  };

  return { fastify, hooks, decorations };
}

function createMockReply(): FastifyReplyLike & {
  sentPayload?: unknown;
  headers: Record<string, string>;
} {
  const headers: Record<string, string> = {};
  const reply: FastifyReplyLike & { sentPayload?: unknown; headers: Record<string, string> } = {
    statusCode: 200,
    sent: false,
    headers,
    code(c) {
      reply.statusCode = c;
      return reply;
    },
    header(k, v) {
      headers[k] = v;
      return reply;
    },
    send(payload) {
      reply.sent = true;
      reply.sentPayload = payload;
      return reply;
    },
  };
  return reply;
}

describe("Fastify Caching Plugin", () => {
  let adapter: MemoryAdapter;

  beforeEach(() => {
    adapter = new MemoryAdapter();
  });

  it("stores response in cache on send and serves cached payload on subsequent request", async () => {
    const { fastify, hooks } = createMockFastify();
    kvdockFastifyPlugin(fastify, { adapter, ttl: 60 });

    const req: FastifyRequestLike = {
      method: "GET",
      url: "/api/products",
      headers: {},
    };

    // First request: MISS, runs onSend hook to cache
    const reply1 = createMockReply();
    for (const hook of hooks.onRequest) {
      await hook(req, reply1);
    }
    expect(reply1.sent).toBe(false);

    for (const hook of hooks.onSend) {
      await hook(req, reply1, JSON.stringify([{ id: 1, name: "Widget" }]));
    }
    expect(reply1.headers["X-Cache"]).toBe("MISS");

    // Second request: HIT in onRequest hook
    const reply2 = createMockReply();
    for (const hook of hooks.onRequest) {
      await hook(req, reply2);
    }
    expect(reply2.sent).toBe(true);
    expect(reply2.headers["X-Cache"]).toBe("HIT");
    expect(reply2.sentPayload).toBe(JSON.stringify([{ id: 1, name: "Widget" }]));
  });

  it("returns 304 when If-None-Match header matches cached etag", async () => {
    const { fastify, hooks } = createMockFastify();
    kvdockFastifyPlugin(fastify, { adapter, ttl: 60 });

    const req: FastifyRequestLike = {
      method: "GET",
      url: "/api/version",
      headers: {},
    };

    const reply1 = createMockReply();
    for (const hook of hooks.onSend) {
      await hook(req, reply1, "v1.0.0");
    }
    const etag = reply1.headers.ETag;
    expect(etag).toBeDefined();

    // Revalidate request
    const revalReq: FastifyRequestLike = {
      method: "GET",
      url: "/api/version",
      headers: { "if-none-match": etag },
    };
    const reply2 = createMockReply();
    for (const hook of hooks.onRequest) {
      await hook(revalReq, reply2);
    }

    expect(reply2.sent).toBe(true);
    expect(reply2.statusCode).toBe(304);
    expect(reply2.headers["X-Cache"]).toBe("HIT-REVALIDATED");
  });
});
