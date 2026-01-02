import type { FastifyInstance } from 'fastify';
import { prisma } from '../../infrastructure/db.js';
import { requireCompanyIdParam } from '../../utils/tenant.js';
import { Prisma } from '@prisma/client';

function normalizeCurrencyOrThrow(input: unknown, fieldName = 'currency'): string {
  const s = String(input ?? '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(s)) {
    throw Object.assign(new Error(`${fieldName} must be a 3-letter code (e.g. MMK, USD)`), {
      statusCode: 400,
    });
  }
  return s;
}

function parseIsoDateOrThrow(input: unknown, fieldName = 'asOfDate'): Date {
  const s = String(input ?? '').trim();
  const d = new Date(s);
  if (!s || Number.isNaN(d.getTime())) {
    throw Object.assign(new Error(`${fieldName} must be a valid ISO date string`), {
      statusCode: 400,
    });
  }
  return d;
}

export async function currenciesRoutes(fastify: FastifyInstance) {
  // Tenant-scoped; require JWT
  fastify.addHook('preHandler', fastify.authenticate);

  // Overview: currencies + latest rate (relative to company baseCurrency)
  fastify.get('/companies/:companyId/currencies/overview', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);

    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { baseCurrency: true },
    });
    if (!company) {
      reply.status(404);
      return { error: 'company not found' };
    }
    const baseCurrency = (company.baseCurrency ?? '').trim().toUpperCase() || null;

    // Ensure base currency exists as a Currency row (if set).
    if (baseCurrency) {
      try {
        await (prisma as any).currency.upsert({
          where: { companyId_code: { companyId, code: baseCurrency } },
          create: { companyId, code: baseCurrency, name: null, symbol: null, isActive: true },
          update: { isActive: true },
        });
      } catch {
        // Ignore (older Prisma client or race). Overview will still function without it.
      }
    }

    const currencies: any[] = await (prisma as any).currency.findMany({
      where: { companyId, isActive: true },
      orderBy: [{ code: 'asc' }],
    });

    // If no base currency is set, return currencies without rates (Option 1 requires base currency for meaning).
    if (!baseCurrency) {
      return {
        baseCurrency: null,
        currencies: currencies.map((c) => ({
          id: c.id,
          code: c.code,
          name: c.name,
          symbol: c.symbol,
          isBase: false,
          latestRateToBase: null,
          latestAsOfDate: null,
        })),
      };
    }

    // Fetch latest exchange rate per currency (for current baseCurrency snapshot).
    // We do this with a simple N+1, but currency count is typically small for SMEs.
    const result = [];
    for (const c of currencies) {
      const latest = await (prisma as any).exchangeRate.findFirst({
        where: { companyId, currencyId: c.id, baseCurrency },
        orderBy: [{ asOfDate: 'desc' }, { id: 'desc' }],
      });
      result.push({
        id: c.id,
        code: c.code,
        name: c.name,
        symbol: c.symbol,
        isBase: c.code === baseCurrency,
        latestRateToBase: latest ? latest.rateToBase.toString() : null,
        latestAsOfDate: latest ? latest.asOfDate : null,
      });
    }

    return { baseCurrency, currencies: result };
  });

  // Create currency
  fastify.post('/companies/:companyId/currencies', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    const body = request.body as { code?: string; name?: string | null; symbol?: string | null };

    try {
      const code = normalizeCurrencyOrThrow(body.code, 'code');
      const name = body.name === undefined ? null : (body.name ?? null);
      const symbol = body.symbol === undefined ? null : (body.symbol ?? null);

      const created = await (prisma as any).currency.create({
        data: {
          companyId,
          code,
          name: name ? String(name).trim() : null,
          symbol: symbol ? String(symbol).trim() : null,
          isActive: true,
        },
      });
      return created;
    } catch (err: any) {
      const statusCode = err?.statusCode ?? 400;
      reply.status(statusCode);
      return { error: err?.message ?? 'invalid request' };
    }
  });

  // Update currency metadata
  fastify.put('/companies/:companyId/currencies/:currencyId', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    const currencyId = Number((request.params as any)?.currencyId);
    if (!Number.isInteger(currencyId) || currencyId <= 0) {
      reply.status(400);
      return { error: 'invalid currencyId' };
    }

    const body = request.body as { name?: string | null; symbol?: string | null; isActive?: boolean };
    const existing = await (prisma as any).currency.findFirst({ where: { id: currencyId, companyId } });
    if (!existing) {
      reply.status(404);
      return { error: 'currency not found' };
    }

    const updated = await (prisma as any).currency.update({
      where: { id: currencyId },
      data: {
        ...(body.name !== undefined ? { name: body.name ? String(body.name).trim() : null } : {}),
        ...(body.symbol !== undefined ? { symbol: body.symbol ? String(body.symbol).trim() : null } : {}),
        ...(body.isActive !== undefined ? { isActive: !!body.isActive } : {}),
      },
    });
    return updated;
  });

  // Delete (soft) currency
  fastify.delete('/companies/:companyId/currencies/:currencyId', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    const currencyId = Number((request.params as any)?.currencyId);
    if (!Number.isInteger(currencyId) || currencyId <= 0) {
      reply.status(400);
      return { error: 'invalid currencyId' };
    }

    const company = await prisma.company.findUnique({ where: { id: companyId }, select: { baseCurrency: true } });
    if (!company) {
      reply.status(404);
      return { error: 'company not found' };
    }
    const baseCurrency = (company.baseCurrency ?? '').trim().toUpperCase() || null;

    const existing = await (prisma as any).currency.findFirst({ where: { id: currencyId, companyId } });
    if (!existing) {
      reply.status(404);
      return { error: 'currency not found' };
    }
    if (baseCurrency && String(existing.code).toUpperCase() === baseCurrency) {
      reply.status(400);
      return { error: 'cannot delete base currency' };
    }

    await (prisma as any).currency.update({
      where: { id: currencyId },
      data: { isActive: false },
    });
    return { ok: true };
  });

  // Exchange-rate history for a currency code (relative to company base currency)
  fastify.get('/companies/:companyId/currencies/:code/rates', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    const code = normalizeCurrencyOrThrow((request.params as any)?.code, 'code');

    const company = await prisma.company.findUnique({ where: { id: companyId }, select: { baseCurrency: true } });
    const baseCurrency = (company?.baseCurrency ?? '').trim().toUpperCase() || null;
    if (!baseCurrency) {
      reply.status(400);
      return { error: 'baseCurrency must be set to manage exchange rates' };
    }

    const currency = await (prisma as any).currency.findFirst({ where: { companyId, code, isActive: true } });
    if (!currency) {
      reply.status(404);
      return { error: 'currency not found' };
    }

    const rows = await (prisma as any).exchangeRate.findMany({
      where: { companyId, currencyId: currency.id, baseCurrency },
      orderBy: [{ asOfDate: 'desc' }, { id: 'desc' }],
      take: 200,
    });

    return rows.map((r: any) => ({
      id: r.id,
      currencyCode: code,
      baseCurrency,
      rateToBase: r.rateToBase.toString(),
      asOfDate: r.asOfDate,
      createdAt: r.createdAt,
    }));
  });

  // Add an exchange rate snapshot for a currency code (reference-only)
  fastify.post('/companies/:companyId/currencies/:code/rates', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    const code = normalizeCurrencyOrThrow((request.params as any)?.code, 'code');
    const body = request.body as { rateToBase?: number | string; asOfDate?: string };

    const company = await prisma.company.findUnique({ where: { id: companyId }, select: { baseCurrency: true } });
    const baseCurrency = (company?.baseCurrency ?? '').trim().toUpperCase() || null;
    if (!baseCurrency) {
      reply.status(400);
      return { error: 'baseCurrency must be set to manage exchange rates' };
    }

    const currency = await (prisma as any).currency.findFirst({ where: { companyId, code, isActive: true } });
    if (!currency) {
      reply.status(404);
      return { error: 'currency not found' };
    }
    if (code === baseCurrency) {
      reply.status(400);
      return { error: 'base currency does not require an exchange rate' };
    }

    try {
      const asOfDate = parseIsoDateOrThrow(body.asOfDate, 'asOfDate');
      const rateNum = Number(body.rateToBase);
      if (!Number.isFinite(rateNum) || rateNum <= 0) {
        throw Object.assign(new Error('rateToBase must be a positive number'), { statusCode: 400 });
      }

      const created = await (prisma as any).exchangeRate.create({
        data: {
          companyId,
          currencyId: currency.id,
          baseCurrency,
          rateToBase: new Prisma.Decimal(rateNum),
          asOfDate,
        },
      });
      return {
        id: created.id,
        currencyCode: code,
        baseCurrency,
        rateToBase: created.rateToBase.toString(),
        asOfDate: created.asOfDate,
        createdAt: created.createdAt,
      };
    } catch (err: any) {
      const statusCode = err?.statusCode ?? 400;
      reply.status(statusCode);
      return { error: err?.message ?? 'invalid request' };
    }
  });
}


