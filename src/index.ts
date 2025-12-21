import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from 'fastify-jwt';
import { authRoutes } from './modules/auth/auth.routes.js';
import { companiesRoutes } from './modules/companies/companies.routes.js';
import { ledgerRoutes } from './modules/ledger/ledger.routes.js';
import { booksRoutes } from './modules/books/books.routes.js';
import { pitiRoutes } from './modules/integrations/piti.routes.js';
import { inventoryRoutes } from './modules/inventory/inventory.routes.js';
import { purchaseBillsRoutes } from './modules/purchases/purchaseBills.routes.js';
import { apAgingRoutes } from './modules/reports/apAging.routes.js';
import { dashboardRoutes } from './modules/reports/dashboard.routes.js';
import { taxesRoutes } from './modules/taxes/taxes.routes.js';
import { runWithTenant } from './infrastructure/tenantContext.js';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return String(v);
}

const JWT_SECRET = requireEnv('JWT_SECRET');
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN ?? '8h';

const fastify = Fastify({ logger: true });

async function buildApp() {
  await fastify.register(cors, {
    origin: true,
    // IMPORTANT: allow preflight for all write methods (Cloud Run / browser clients).
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'Idempotency-Key',
      'idempotency-key',
    ],
  });

  fastify.register(jwt as any, {
    secret: JWT_SECRET,
    sign: {
      // Default token expiration for all fastify.jwt.sign() calls unless overridden.
      expiresIn: JWT_EXPIRES_IN,
    },
  });

  // Basic rate limiting (no external deps). In production this provides a minimum
  // safety net against brute-force + abusive traffic. For multi-instance/global
  // limits, replace with a Redis-backed or gateway-level rate limiter.
  const isProd = (process.env.NODE_ENV ?? '').toLowerCase() === 'production';
  const disableRateLimit =
    !isProd && (process.env.DISABLE_RATE_LIMIT ?? '').toLowerCase() === 'true';

  const authWindowMs = Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS ?? 60_000);
  const authMax = Number(process.env.AUTH_RATE_LIMIT_MAX ?? 10);
  const globalWindowMs = Number(process.env.GLOBAL_RATE_LIMIT_WINDOW_MS ?? 60_000);
  const globalMax = Number(process.env.GLOBAL_RATE_LIMIT_MAX ?? 300);

  type Bucket = { windowStartMs: number; count: number };
  const buckets = new Map<string, Bucket>();
  let seen = 0;

  function hit(key: string, max: number, windowMs: number, nowMs: number): boolean {
    const prev = buckets.get(key);
    if (!prev || nowMs - prev.windowStartMs >= windowMs) {
      buckets.set(key, { windowStartMs: nowMs, count: 1 });
      return true;
    }
    if (prev.count >= max) return false;
    prev.count += 1;
    return true;
  }

  fastify.addHook('onRequest', async (request, reply) => {
    if (disableRateLimit) return;

    const nowMs = Date.now();
    const ip = (request.ip ?? request.socket?.remoteAddress ?? 'unknown').toString();
    const path = (request.url ?? '').split('?')[0] ?? '';

    // Stricter limits for auth endpoints
    const isAuthEndpoint =
      request.method === 'POST' && (path === '/login' || path === '/register');

    const key = `${isAuthEndpoint ? 'auth' : 'global'}:${ip}`;
    const ok = isAuthEndpoint
      ? hit(key, authMax, authWindowMs, nowMs)
      : hit(key, globalMax, globalWindowMs, nowMs);

    if (!ok) {
      reply.status(429).send({ error: 'Too Many Requests' });
      return;
    }

    // Opportunistic pruning to avoid unbounded growth.
    // Every ~1k requests, remove buckets idle for >2 windows.
    seen += 1;
    if (seen % 1000 === 0) {
      const authIdle = authWindowMs * 2;
      const globalIdle = globalWindowMs * 2;
      for (const [k, b] of buckets.entries()) {
        const idleLimit = k.startsWith('auth:') ? authIdle : globalIdle;
        if (nowMs - b.windowStartMs >= idleLimit) buckets.delete(k);
      }
    }
  });

  // Decorate fastify with authenticate
  fastify.decorate('authenticate', async function (request: any, reply: any) {
    try {
      await request.jwtVerify();
    } catch (err) {
      reply.send(err);
    }
  });

  // Health check
  fastify.get('/health', async () => {
    return { status: 'ok' };
  });

  // Register Modules
  await fastify.register(authRoutes);
  await fastify.register(companiesRoutes);
  await fastify.register(ledgerRoutes);
  await fastify.register(booksRoutes);
  await fastify.register(pitiRoutes);
  await fastify.register(inventoryRoutes);
  await fastify.register(purchaseBillsRoutes);
  await fastify.register(apAgingRoutes);
  await fastify.register(dashboardRoutes);
  await fastify.register(taxesRoutes);

  // Tenant context (ALS) must be installed AFTER module-level auth hooks are registered,
  // so it can wrap the actual route handler execution with a verified tenant id.
  fastify.addHook('preHandler', ((request: any, _reply: any, done: any) => {
    const companyId = Number(request?.user?.companyId);
    if (!Number.isInteger(companyId) || companyId <= 0) return done();
    return runWithTenant(companyId, done);
  }) as any);

  return fastify;
}

const start = async () => {
  try {
    const app = await buildApp();
    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`Server running on http://localhost:${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
