import type { FastifyInstance } from 'fastify';
import { prisma } from '../../infrastructure/db.js';
import { requireCompanyIdParam } from '../../utils/tenant.js';
import { requireAnyRole, Roles } from '../../utils/rbac.js';
import { parseDateInput } from '../../utils/date.js';
import { computeCashflowForecast } from './cashflow.service.js';
import { runAgent } from '../../ai/orchestrator.js';
import { writeAuditLog } from '../../infrastructure/auditLog.js';
import { normalizeToDay } from '../../utils/date.js';

type SettingsBody = {
  defaultArDelayDays?: number;
  defaultApDelayDays?: number;
  minCashBuffer?: number;
};

type RecurringBody = {
  direction: 'INFLOW' | 'OUTFLOW';
  name: string;
  amount: number;
  currency?: string | null;
  startDate: string; // YYYY-MM-DD
  endDate?: string | null;
  frequency: 'WEEKLY' | 'MONTHLY';
  interval?: number;
  isActive?: boolean;
};

function requireInt(name: string, v: any, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    throw Object.assign(new Error(`${name} must be an integer between ${min} and ${max}`), { statusCode: 400 });
  }
  return n;
}

function requireMoney(name: string, v: any): number {
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw Object.assign(new Error(`${name} must be a valid number`), { statusCode: 400 });
  }
  return n;
}

function normCurrency(v: any): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toUpperCase();
  if (!s) return null;
  if (!/^[A-Z]{3}$/.test(s)) {
    throw Object.assign(new Error('currency must be a 3-letter code (e.g. MMK, USD)'), { statusCode: 400 });
  }
  return s;
}

export async function cashflowRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', fastify.authenticate);

  // ---------------------------------------------------------------------------
  // Settings (assumptions)
  // ---------------------------------------------------------------------------
  fastify.get('/companies/:companyId/cashflow/settings', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);

    const existing = await prisma.cashflowSettings.findUnique({ where: { companyId } });
    if (existing) return existing;

    // Create defaults lazily so existing tenants work without migrations on day 1.
    return await prisma.cashflowSettings.create({
      data: {
        companyId,
        defaultArDelayDays: 7,
        defaultApDelayDays: 0,
        minCashBuffer: 0 as any,
      },
    });
  });

  fastify.put('/companies/:companyId/cashflow/settings', async (request, reply) => {
    requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER/ACCOUNTANT');
    const companyId = requireCompanyIdParam(request, reply);
    const body = (request.body ?? {}) as SettingsBody;

    const data: any = {};
    if (body.defaultArDelayDays !== undefined) data.defaultArDelayDays = requireInt('defaultArDelayDays', body.defaultArDelayDays, 0, 180);
    if (body.defaultApDelayDays !== undefined) data.defaultApDelayDays = requireInt('defaultApDelayDays', body.defaultApDelayDays, 0, 180);
    if (body.minCashBuffer !== undefined) data.minCashBuffer = requireMoney('minCashBuffer', body.minCashBuffer);

    if (!Object.keys(data).length) {
      reply.status(400);
      return { error: 'at least one field is required (defaultArDelayDays, defaultApDelayDays, minCashBuffer)' };
    }

    // Upsert so we don't require an explicit create step.
    return await prisma.cashflowSettings.upsert({
      where: { companyId },
      create: { companyId, defaultArDelayDays: 7, defaultApDelayDays: 0, minCashBuffer: 0 as any, ...data },
      update: data,
    });
  });

  // ---------------------------------------------------------------------------
  // Forecast + alerts (deterministic; safe read-only)
  // ---------------------------------------------------------------------------
  fastify.get('/companies/:companyId/cashflow/forecast', async (request, reply) => {
    // Owners and viewers can read forecasts.
    requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT, Roles.VIEWER, Roles.CLERK], 'any authenticated role');
    const companyId = requireCompanyIdParam(request, reply);
    const q = request.query as any;

    const weeks = q?.weeks !== undefined ? requireInt('weeks', q.weeks, 4, 26) : 13;
    const scenario = (String(q?.scenario ?? 'base').trim().toLowerCase() || 'base') as any;
    if (!['base', 'conservative', 'optimistic'].includes(scenario)) {
      reply.status(400);
      return { error: 'scenario must be one of base, conservative, optimistic' };
    }

    const asOfDate = q?.asOfDate ? parseDateInput(String(q.asOfDate)) : null;
    if (q?.asOfDate && !asOfDate) {
      reply.status(400);
      return { error: 'asOfDate must be a valid date (YYYY-MM-DD)' };
    }

    const day = normalizeToDay(asOfDate ?? new Date());

    // Prefer cached snapshot if available (background refreshed). Fall back to compute.
    const snap = await prisma.cashflowForecastSnapshot.findFirst({
      where: { companyId, scenario, asOfDate: day },
      orderBy: { computedAt: 'desc' },
      select: { computedAt: true, payload: true },
    });

    if (snap?.payload && typeof snap.payload === 'object') {
      return { ...(snap.payload as any), computedAt: snap.computedAt.toISOString(), source: 'snapshot' };
    }

    const opts: any = { weeks, scenario, asOfDate: day };
    const result = await prisma.$transaction(async (tx) => {
      return await computeCashflowForecast(tx as any, companyId, opts);
    });

    // Best-effort persist snapshot for future fast loads.
    try {
      await prisma.cashflowForecastSnapshot.create({
        data: {
          companyId,
          scenario,
          asOfDate: day,
          computedAt: new Date(),
          payload: result as any,
        },
      });
    } catch {
      // ignore (race / no table yet)
    }

    return { ...(result as any), computedAt: new Date().toISOString(), source: 'computed' };
  });

  fastify.get('/companies/:companyId/cashflow/alerts', async (request, reply) => {
    requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT, Roles.VIEWER, Roles.CLERK], 'any authenticated role');
    const companyId = requireCompanyIdParam(request, reply);
    const q = request.query as any;
    const scenario = (String(q?.scenario ?? 'base').trim().toLowerCase() || 'base') as any;
    if (!['base', 'conservative', 'optimistic'].includes(scenario)) {
      reply.status(400);
      return { error: 'scenario must be one of base, conservative, optimistic' };
    }
    const result = await prisma.$transaction(async (tx) => {
      return await computeCashflowForecast(tx as any, companyId, { weeks: 13, scenario });
    });
    return { asOfDate: result.asOfDate, scenario: result.scenario, alerts: result.alerts, warnings: result.warnings };
  });

  // ---------------------------------------------------------------------------
  // Copilot Insights (AI, optional)
  // ---------------------------------------------------------------------------
  fastify.get('/companies/:companyId/cashflow/insights', async (request, reply) => {
    requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER/ACCOUNTANT');
    const companyId = requireCompanyIdParam(request, reply);
    const q = request.query as any;
    const scenario = (String(q?.scenario ?? 'base').trim().toLowerCase() || 'base') as any;
    if (!['base', 'conservative', 'optimistic'].includes(scenario)) {
      reply.status(400);
      return { error: 'scenario must be one of base, conservative, optimistic' };
    }

    const forecast = await prisma.$transaction(async (tx) => {
      return await computeCashflowForecast(tx as any, companyId, { weeks: 13, scenario });
    });

    const userId = Number((request as any)?.user?.userId ?? 0) || null;

    const ai = await runAgent({
      agentId: 'cashflow_copilot_insights',
      companyId,
      userId,
      scenario,
      input: { forecast },
    });

    await prisma.$transaction(async (tx) => {
      await writeAuditLog(tx as any, {
        companyId,
        userId,
        action: 'cashflow_copilot.insights_viewed',
        entityType: 'cashflow',
        entityId: scenario,
        metadata: {
          ok: ai.ok,
          code: ai.ok ? null : ai.code,
          provider: ai.ok ? ai.provider : null,
          model: ai.ok ? ai.model : null,
          cached: ai.ok ? ai.cached : null,
          traceId: ai.ok ? ai.traceId : null,
        },
      });
    });

    if (!ai.ok) {
      // If AI is not configured, return 501 so the UI can show a setup hint.
      reply.status(ai.code === 'AI_NOT_CONFIGURED' ? 501 : 502);
      return { error: ai.error, code: ai.code };
    }

    return {
      asOfDate: forecast.asOfDate,
      scenario: forecast.scenario,
      provider: ai.provider,
      model: ai.model,
      cached: ai.cached,
      traceId: ai.traceId,
      insights: ai.data,
    };
  });

  // ---------------------------------------------------------------------------
  // Recurring items (owner managed)
  // ---------------------------------------------------------------------------
  fastify.get('/companies/:companyId/cashflow/recurring-items', async (request, reply) => {
    requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT, Roles.VIEWER, Roles.CLERK], 'any authenticated role');
    const companyId = requireCompanyIdParam(request, reply);
    return await prisma.cashflowRecurringItem.findMany({
      where: { companyId },
      orderBy: [{ isActive: 'desc' }, { startDate: 'asc' }, { id: 'asc' }],
    });
  });

  fastify.post('/companies/:companyId/cashflow/recurring-items', async (request, reply) => {
    requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER/ACCOUNTANT');
    const companyId = requireCompanyIdParam(request, reply);
    const body = request.body as RecurringBody;

    if (!body || typeof body !== 'object') {
      reply.status(400);
      return { error: 'body is required' };
    }
    if (!['INFLOW', 'OUTFLOW'].includes(String(body.direction))) {
      reply.status(400);
      return { error: 'direction must be INFLOW or OUTFLOW' };
    }
    const name = String(body.name ?? '').trim();
    if (!name) {
      reply.status(400);
      return { error: 'name is required' };
    }
    const amount = requireMoney('amount', body.amount);
    if (amount <= 0) {
      reply.status(400);
      return { error: 'amount must be > 0' };
    }
    if (!['WEEKLY', 'MONTHLY'].includes(String(body.frequency))) {
      reply.status(400);
      return { error: 'frequency must be WEEKLY or MONTHLY' };
    }
    const startDate = parseDateInput(body.startDate);
    if (!startDate) {
      reply.status(400);
      return { error: 'startDate must be a valid date (YYYY-MM-DD)' };
    }
    const endDate = body.endDate ? parseDateInput(body.endDate) : null;
    if (body.endDate && !endDate) {
      reply.status(400);
      return { error: 'endDate must be a valid date (YYYY-MM-DD) or null' };
    }
    const interval = body.interval !== undefined ? requireInt('interval', body.interval, 1, 52) : 1;
    const currency = normCurrency(body.currency);

    return await prisma.cashflowRecurringItem.create({
      data: {
        companyId,
        direction: body.direction as any,
        name,
        amount: amount as any,
        currency,
        startDate,
        endDate,
        frequency: body.frequency as any,
        interval,
        isActive: body.isActive ?? true,
      },
    });
  });

  fastify.put('/companies/:companyId/cashflow/recurring-items/:id', async (request, reply) => {
    requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER/ACCOUNTANT');
    const companyId = requireCompanyIdParam(request, reply);
    const id = Number((request.params as any)?.id);
    if (!Number.isFinite(id)) {
      reply.status(400);
      return { error: 'invalid id' };
    }
    const body = (request.body ?? {}) as Partial<RecurringBody>;
    const data: any = {};

    if (body.direction !== undefined) {
      if (!['INFLOW', 'OUTFLOW'].includes(String(body.direction))) {
        reply.status(400);
        return { error: 'direction must be INFLOW or OUTFLOW' };
      }
      data.direction = body.direction;
    }
    if (body.name !== undefined) {
      const name = String(body.name ?? '').trim();
      if (!name) {
        reply.status(400);
        return { error: 'name cannot be empty' };
      }
      data.name = name;
    }
    if (body.amount !== undefined) {
      const amount = requireMoney('amount', body.amount);
      if (amount <= 0) {
        reply.status(400);
        return { error: 'amount must be > 0' };
      }
      data.amount = amount;
    }
    if (body.currency !== undefined) data.currency = normCurrency(body.currency);
    if (body.frequency !== undefined) {
      if (!['WEEKLY', 'MONTHLY'].includes(String(body.frequency))) {
        reply.status(400);
        return { error: 'frequency must be WEEKLY or MONTHLY' };
      }
      data.frequency = body.frequency;
    }
    if (body.interval !== undefined) data.interval = requireInt('interval', body.interval, 1, 52);
    if (body.isActive !== undefined) data.isActive = !!body.isActive;
    if (body.startDate !== undefined) {
      const d = parseDateInput(body.startDate);
      if (!d) {
        reply.status(400);
        return { error: 'startDate must be YYYY-MM-DD' };
      }
      data.startDate = d;
    }
    if (body.endDate !== undefined) {
      if (body.endDate === null || body.endDate === '') data.endDate = null;
      else {
        const d = parseDateInput(body.endDate);
        if (!d) {
          reply.status(400);
          return { error: 'endDate must be YYYY-MM-DD or null' };
        }
        data.endDate = d;
      }
    }

    if (!Object.keys(data).length) {
      reply.status(400);
      return { error: 'no fields provided' };
    }

    const updated = await prisma.cashflowRecurringItem.updateMany({
      where: { id, companyId },
      data,
    });
    if ((updated as any).count !== 1) {
      reply.status(404);
      return { error: 'recurring item not found' };
    }
    return await prisma.cashflowRecurringItem.findFirst({ where: { id, companyId } });
  });

  fastify.delete('/companies/:companyId/cashflow/recurring-items/:id', async (request, reply) => {
    requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER/ACCOUNTANT');
    const companyId = requireCompanyIdParam(request, reply);
    const id = Number((request.params as any)?.id);
    if (!Number.isFinite(id)) {
      reply.status(400);
      return { error: 'invalid id' };
    }
    const res = await prisma.cashflowRecurringItem.deleteMany({ where: { id, companyId } });
    if ((res as any).count !== 1) {
      reply.status(404);
      return { error: 'recurring item not found' };
    }
    return { ok: true };
  });
}

