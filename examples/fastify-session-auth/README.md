# KVDock Example: Fastify Session Store & Failover Authentication Cookbook

Demonstrates an end-to-end authentication session store for Fastify using KVDock, HMAC-SHA256 cookie signing, and multi-adapter failover (`withFailover`) across Redis/SQLite/in-memory stores.

## Features
- **HMAC-SHA256 Signed Cookies**: Signs session identifiers (`s:<sessionId>.<hmac>`) and verifies signatures with `crypto.timingSafeEqual`.
- **Session Lifecycle (`req.session`)**: Shows session creation (`req.session.set`), authenticated lookup (`req.session.get`), and logout invalidation (`req.session.destroy`).
- **Active-Passive Store Failover**: Uses `withFailover([primaryAdapter, standbyAdapter], { replicateWrites: true })` so active sessions survive a primary Redis cluster outage without logging users out.
- **Fastify Plugin Integration**: Pairs alongside `kvdockFastifyPlugin` (`src/integrations/fastify/index.ts`).

## Quickstart

From the repository root, run the cookbook with `npm run start` (via `tsx`):

```bash
npx tsx examples/fastify-session-auth/index.ts
```

Or if running inside a standalone Fastify project where `"start": "tsx examples/fastify-session-auth/index.ts"` is configured in `package.json`:

```bash
npm run start
```