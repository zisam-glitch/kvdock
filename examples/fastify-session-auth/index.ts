/**
 * KVDock Example: Fastify Session Store & Multi-Adapter Failover Authentication Cookbook
 *
 * Demonstrates:
 * 1. HMAC-SHA256 cookie signing and constant-time signature verification.
 * 2. Full session lifecycle (`req.session.set`, `req.session.get`, `req.session.destroy`).
 * 3. Active-Passive failover (`withFailover`) pairing a primary Redis/cluster store with a standby fallback.
 * 4. Route caching integration via `kvdockFastifyPlugin`.
 */

import crypto from "node:crypto";
import { KVDock, withFailover } from "../../src/index.js";
import { MemoryAdapter } from "../../src/adapters/memory/index.js";
import { kvdockFastifyPlugin } from "../../src/integrations/fastify/index.js";

export interface SessionData {
  userId: string;
  role: "admin" | "member";
  issuedAt: number;
}

export interface FastifySessionHandle {
  id: string;
  get<T = SessionData>(): Promise<T | null>;
  set<T = SessionData>(data: T, ttlSeconds?: number): Promise<void>;
  destroy(): Promise<void>;
}

export function signSessionCookie(sessionId: string, secret: string): string {
  const mac = crypto.createHmac("sha256", secret).update(sessionId).digest("base64url");
  return `s:${sessionId}.${mac}`;
}

export function unsignSessionCookie(cookieValue: string, secret: string): string | null {
  if (!cookieValue.startsWith("s:")) return null;
  const raw = cookieValue.slice(2);
  const dotIndex = raw.lastIndexOf(".");
  if (dotIndex <= 0) return null;

  const sessionId = raw.slice(0, dotIndex);
  const providedMac = raw.slice(dotIndex + 1);
  const expectedMac = crypto.createHmac("sha256", secret).update(sessionId).digest("base64url");

  const a = Buffer.from(providedMac);
  const b = Buffer.from(expectedMac);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return null;
  }
  return sessionId;
}

export function createSessionHandle(
  dock: KVDock,
  sessionId: string,
  prefix = "fastify:sess:",
): FastifySessionHandle {
  const key = `${prefix}${sessionId}`;
  return {
    id: sessionId,
    async get<T = SessionData>() {
      return dock.get<T>(key);
    },
    async set<T = SessionData>(data: T, ttlSeconds = 3600) {
      await dock.set(key, data, { ttl: ttlSeconds * 1000 });
    },
    async destroy() {
      await dock.delete(key);
    },
  };
}

async function main() {
  console.log("🔐 Initializing KVDock Fastify Session Store & Failover Cookbook...\n");

  const COOKIE_SECRET = "kvdock-production-hmac-secret-key-2026";

  // Primary store (e.g. Redis cluster adapter in production) + warm standby fallback (e.g. SQLite / Memory)
  const primaryRedisLikeStore = new MemoryAdapter();
  const standbyFallbackStore = new MemoryAdapter();

  const failoverAdapter = withFailover([primaryRedisLikeStore, standbyFallbackStore], {
    replicateWrites: true,
    onFailover: (from, to) =>
      console.log(`🔄 [Failover] Switched active session store from Adapter #${from} to Adapter #${to}`),
    onFailback: (from, to) =>
      console.log(`🔙 [Failback] Restored active session store from Adapter #${from} to Adapter #${to}`),
  });

  const sessionDock = new KVDock({ adapter: failoverAdapter });

  // Register kvdockFastifyPlugin on a lightweight Fastify-compatible instance
  const hooks: { onRequest: Function[]; onSend: Function[] } = { onRequest: [], onSend: [] };
  const decorated: Record<string, unknown> = {};
  kvdockFastifyPlugin(
    {
      addHook(name, fn) {
        hooks[name].push(fn);
      },
      decorate(name, val) {
        decorated[name] = val;
      },
    },
    { adapter: failoverAdapter, ttl: 60, prefix: "fastify:cache:" },
  );

  // --- 1. Login & Session Creation (req.session.set) ---
  console.log("--- 1. Login: Creating & Signing Session (`req.session.set`) ---");
  const sessionId = crypto.randomUUID();
  const reqSession = createSessionHandle(sessionDock, sessionId);

  await reqSession.set({
    userId: "usr_42",
    role: "admin",
    issuedAt: Date.now(),
  });

  const signedCookie = signSessionCookie(sessionId, COOKIE_SECRET);
  console.log(`   ✅ Created session ID: ${sessionId}`);
  console.log(`   🍪 Signed Set-Cookie value: sid=${signedCookie}; HttpOnly; Secure; SameSite=Lax`);

  // --- 2. Request Verification ---
  console.log("\n--- 2. Authenticated Request: Verifying Cookie & Reading Session ---");
  const verifiedId = unsignSessionCookie(signedCookie, COOKIE_SECRET);
  if (!verifiedId) throw new Error("Signature verification failed");

  const verifiedSession = await createSessionHandle(sessionDock, verifiedId).get();
  console.log("   ✅ Signature verified! Loaded session payload:", verifiedSession);

  // Reject tampered cookie
  const tamperedCookie = `${signedCookie}tampered`;
  console.log(
    `   🛡️  Tampered cookie check: ${unsignSessionCookie(tamperedCookie, COOKIE_SECRET) === null ? "Rejected (null)" : "Failed"}`,
  );

  // --- 3. Primary Store Outage -> Standby Failover ---
  console.log("\n--- 3. Simulating Primary Redis Cluster Failover ---");
  failoverAdapter.failover();
  const sessionFromStandby = await createSessionHandle(sessionDock, verifiedId).get();
  console.log("   ✅ Session seamlessly served from replicated standby adapter:", sessionFromStandby);
  failoverAdapter.failback();

  // --- 4. Logout Invalidation (req.session.destroy) ---
  console.log("\n--- 4. Logout: Invalidating Session (`req.session.destroy`) ---");
  await reqSession.destroy();
  const afterLogout = await reqSession.get();
  console.log(`   ✅ Session after logout: ${JSON.stringify(afterLogout)} (invalidated)`);

  await sessionDock.close();
  console.log("\n🎉 Fastify Session Store & Failover Cookbook completed successfully!");
}

main().catch((err) => {
  console.error("Cookbook failed:", err);
  process.exit(1);
});