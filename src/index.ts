import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import jwt from 'fastify-jwt';
import { authRoutes } from './modules/auth/auth.routes.js';
import { companiesRoutes } from './modules/companies/companies.routes.js';
import { ledgerRoutes } from './modules/ledger/ledger.routes.js';
import { booksRoutes } from './modules/books/books.routes.js';
import { customerAdvancesRoutes } from './modules/books/customerAdvances.routes.js';
import { invoicePublicRoutes } from './modules/books/invoicePublic.routes.js';
import { pitiRoutes } from './modules/integrations/piti.routes.js';
import { inventoryRoutes } from './modules/inventory/inventory.routes.js';
import { purchaseBillsRoutes } from './modules/purchases/purchaseBills.routes.js';
import { purchaseOrdersRoutes } from './modules/purchases/purchaseOrders.routes.js';
import { purchaseReceiptsRoutes } from './modules/purchases/purchaseReceipts.routes.js';
import { vendorCreditsRoutes } from './modules/purchases/vendorCredits.routes.js';
import { vendorAdvancesRoutes } from './modules/purchases/vendorAdvances.routes.js';
import { apAgingRoutes } from './modules/reports/apAging.routes.js';
import { dashboardRoutes } from './modules/reports/dashboard.routes.js';
import { arApSummaryRoutes } from './modules/reports/arApSummary.routes.js';
import { taxesRoutes } from './modules/taxes/taxes.routes.js';
import { currenciesRoutes } from './modules/currencies/currencies.routes.js';
import { cashflowRoutes } from './modules/cashflow/cashflow.routes.js';
import { runWithTenant } from './infrastructure/tenantContext.js';
import { createPerfStore, getPerfStore, isPerfEnabled, runWithPerf } from './infrastructure/perf.js';
import { performance } from 'node:perf_hooks';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return String(v);
}

const JWT_SECRET = requireEnv('JWT_SECRET');
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN ?? '8h';

// Important for public invoice share links: JWT tokens are >100 chars, and the router has a default max param length.
// Without this, GET /public/invoices/:token may not match and will return 404 "Route ... not found".
const fastify = Fastify({ logger: true, maxParamLength: 5000 });

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
      'X-Integration-Key',
      'x-integration-key',
    ],
  });

  // File uploads (used for invoice logo upload).
  await fastify.register(multipart, {
    limits: {
      fileSize: Number(process.env.UPLOAD_MAX_BYTES ?? 1_000_000), // 1MB default
      files: 1,
    },
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
  const publicWindowMs = Number(process.env.PUBLIC_RATE_LIMIT_WINDOW_MS ?? 60_000);
  const publicMax = Number(process.env.PUBLIC_RATE_LIMIT_MAX ?? 120);
  const publicUploadWindowMs = Number(process.env.PUBLIC_UPLOAD_RATE_LIMIT_WINDOW_MS ?? 60_000);
  const publicUploadMax = Number(process.env.PUBLIC_UPLOAD_RATE_LIMIT_MAX ?? 10);

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
      request.method === 'POST' &&
      (path === '/login' ||
        path === '/register' ||
        path === '/login/otp/request' ||
        path === '/login/otp/verify' ||
        path === '/me/phone/request-otp' ||
        path === '/me/phone/verify');

    // Public invoice links are anonymous by design; add a stricter bucket to reduce abuse.
    const isPublicInvoice = typeof path === 'string' && path.startsWith('/public/invoices/');
    const isPublicUpload =
      isPublicInvoice && (request.method === 'POST' || request.method === 'DELETE') && path.includes('/payment-proof');

    const key = `${isAuthEndpoint ? 'auth' : isPublicUpload ? 'publicUpload' : isPublicInvoice ? 'public' : 'global'}:${ip}`;
    const ok = isAuthEndpoint
      ? hit(key, authMax, authWindowMs, nowMs)
      : isPublicUpload
        ? hit(key, publicUploadMax, publicUploadWindowMs, nowMs)
        : isPublicInvoice
          ? hit(key, publicMax, publicWindowMs, nowMs)
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

  // ---------------------------------------------------------------------------
  // Perf logs (env-gated): per-request latency + DB time + query count.
  // ---------------------------------------------------------------------------
  const perfOn = isPerfEnabled();
  fastify.addHook(
    'onRequest',
    ((request: any, _reply: any, done: any) => {
      if (!perfOn) return done();
      const store = createPerfStore();
      // Prefer Fastify request id if present (useful for log correlation)
      if (request?.id) store.requestId = String(request.id);
      // IMPORTANT: do not return the value of done(); keep callback signature.
      runWithPerf(store, () => done());
    }) as any
  );

  fastify.addHook(
    'onResponse',
    ((request: any, reply: any, done: any) => {
      if (!perfOn) return done();
      const s = getPerfStore?.() ?? null;
      if (!s) return done();

      const route = request?.routeOptions?.url ?? request?.routerPath ?? null;
      const method = request?.method ?? null;
      const statusCode = reply?.statusCode ?? null;
      const totalMs = performance.now() - s.startMs;
      const companyId = Number(request?.user?.companyId ?? 0) || null;
      const dbMs = s.dbMs;
      const dbCount = s.dbCount;
      const slow = (s.slowQueries ?? [])
        .slice()
        .sort((a: any, b: any) => (b.ms ?? 0) - (a.ms ?? 0))
        .slice(0, 5);

      // Keep noise low: focus on the known slow flows unless explicitly enabled.
      const path = String(route ?? request?.url ?? '');
      const isHot =
        (method === 'POST' && path === '/companies/:companyId/invoices/:invoiceId/post') ||
        (method === 'POST' && path === '/companies/:companyId/invoices/:invoiceId/payments') ||
        (method === 'POST' && path === '/companies/:companyId/invoices');

      const logAll = String(process.env.PERF_LOG_ALL ?? '').toLowerCase() === 'true';
      if (isHot || logAll) {
        request.log.info(
          {
            kind: 'perf',
            requestId: s.requestId,
            companyId,
            method,
            route,
            statusCode,
            totalMs: Number(totalMs.toFixed(1)),
            dbMs: Number(dbMs.toFixed(1)),
            dbCount,
            appMs: Number((totalMs - dbMs).toFixed(1)),
            topSlowQueries: slow.map((q: any) => ({
              ms: Number((q.ms ?? 0).toFixed(1)),
              model: q.model,
              op: q.operation,
            })),
            spans: s.spans,
          },
          'perf summary'
        );
      }
      return done();
    }) as any
  );

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
    return {
      status: 'ok',
      // Cloud Run injects these automatically; super useful to confirm which revision is serving traffic.
      service: process.env.K_SERVICE ?? null,
      revision: process.env.K_REVISION ?? null,
      configuration: process.env.K_CONFIGURATION ?? null,
      // Optional custom build metadata if you want it later.
      buildSha: process.env.BUILD_SHA ?? null,
    };
  });

  // Register Modules
  await fastify.register(authRoutes);
  await fastify.register(companiesRoutes);
  await fastify.register(ledgerRoutes);
  await fastify.register(booksRoutes);
  await fastify.register(invoicePublicRoutes);
  await fastify.register(customerAdvancesRoutes);
  await fastify.register(pitiRoutes);
  await fastify.register(inventoryRoutes);
  await fastify.register(purchaseBillsRoutes);
  await fastify.register(purchaseOrdersRoutes);
  await fastify.register(purchaseReceiptsRoutes);
  await fastify.register(vendorCreditsRoutes);
  await fastify.register(vendorAdvancesRoutes);
  await fastify.register(apAgingRoutes);
  await fastify.register(dashboardRoutes);
  await fastify.register(arApSummaryRoutes);
  await fastify.register(taxesRoutes);
  await fastify.register(currenciesRoutes);
  await fastify.register(cashflowRoutes);

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
