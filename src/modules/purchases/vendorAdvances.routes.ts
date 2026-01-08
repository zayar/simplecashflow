import type { FastifyInstance } from 'fastify';
import { AccountReportGroup, AccountType, BankingAccountKind, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../infrastructure/db.js';
import { getRedis } from '../../infrastructure/redis.js';
import { withLockBestEffort } from '../../infrastructure/locks.js';
import { runIdempotentRequest } from '../../infrastructure/commandIdempotency.js';
import { writeAuditLog } from '../../infrastructure/auditLog.js';
import { requireCompanyIdParam } from '../../utils/tenant.js';
import { isoNow, parseDateInput } from '../../utils/date.js';
import { toMoneyDecimal } from '../../utils/money.js';
import { requireAnyRole, Roles } from '../../utils/rbac.js';
import { postJournalEntry } from '../ledger/posting.service.js';
import { publishEventsFastPath } from '../../infrastructure/pubsub.js';
import { ensureInventoryCompanyDefaults } from '../inventory/stock.service.js';
import { pickFirstUnusedNumericCode } from '../../utils/tax.js';

async function ensureVendorPrepaymentAccount(tx: any, companyId: number): Promise<number> {
  // Prefer existing by name (tenant-safe)
  const byName = await tx.account.findFirst({
    where: { companyId, type: 'ASSET', name: 'Vendor Prepayments' },
    select: { id: true },
  });
  if (byName?.id) return byName.id;

  // Choose a safe unused ASSET code in 1400..1499 (commonly "prepaids").
  const assetCodes = await tx.account.findMany({
    where: { companyId, type: 'ASSET' },
    select: { code: true },
  });
  const used = new Set<string>(assetCodes.map((a: any) => String(a.code ?? '').trim()).filter(Boolean));
  const desired = !used.has('1400') ? '1400' : pickFirstUnusedNumericCode(used, 1401, 1499);

  const created = await tx.account.create({
    data: {
      companyId,
      code: desired,
      name: 'Vendor Prepayments',
      type: 'ASSET',
      normalBalance: 'DEBIT',
      reportGroup: AccountReportGroup.OTHER_CURRENT_ASSET,
      cashflowActivity: 'OPERATING',
    },
    select: { id: true },
  });
  return created.id;
}

async function ensureAccountsPayableAccount(tx: any, companyId: number): Promise<number> {
  // Prefer company default if set
  const company = await tx.company.findFirst({
    where: { id: companyId },
    select: { accountsPayableAccountId: true },
  });
  if (company?.accountsPayableAccountId) return Number(company.accountsPayableAccountId);

  const byName = await tx.account.findFirst({
    where: { companyId, type: 'LIABILITY', name: 'Accounts Payable' },
    select: { id: true },
  });
  if (byName?.id) return byName.id;

  const byCode = await tx.account.findFirst({
    where: { companyId, type: 'LIABILITY', code: '2000' },
    select: { id: true },
  });
  if (byCode?.id) return byCode.id;

  throw Object.assign(new Error('Accounts Payable account is not configured'), { statusCode: 400 });
}

export async function vendorAdvancesRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', fastify.authenticate);
  const redis = getRedis();

  // List vendor advances (used by "Apply Credits" UI)
  // GET /companies/:companyId/vendors/:vendorId/vendor-advances?onlyOpen=1
  fastify.get('/companies/:companyId/vendors/:vendorId/vendor-advances', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    const vendorId = Number((request.params as any)?.vendorId);
    if (!vendorId || Number.isNaN(vendorId)) {
      reply.status(400);
      return { error: 'invalid vendorId' };
    }

    const onlyOpen = String((request.query as any)?.onlyOpen ?? '1') !== '0';

    const rows = await prisma.vendorAdvance.findMany({
      where: { companyId, vendorId } as any,
      include: {
        location: { select: { id: true, name: true } },
        bankAccount: { select: { id: true, code: true, name: true, type: true } },
        prepaymentAccount: { select: { id: true, code: true, name: true, type: true } },
      },
      orderBy: [{ advanceDate: 'desc' }, { id: 'desc' }],
    });

    const out = (rows ?? [])
      .map((a: any) => {
        const amount = new Prisma.Decimal(a.amount ?? 0).toDecimalPlaces(2);
        const applied = new Prisma.Decimal(a.amountApplied ?? 0).toDecimalPlaces(2);
        const remaining = amount.sub(applied).toDecimalPlaces(2);
        return {
          id: a.id,
          advanceDate: a.advanceDate,
          currency: a.currency ?? null,
          amount: amount.toString(),
          amountApplied: applied.toString(),
          remaining: remaining.toString(),
          receivedVia: a.receivedVia ?? null,
          reference: a.reference ?? null,
          description: a.description ?? null,
          location: a.location ? { id: a.location.id, name: a.location.name } : null,
          bankAccount: a.bankAccount ?? null,
          prepaymentAccount: a.prepaymentAccount ?? null,
          journalEntryId: a.journalEntryId ?? null,
          createdAt: a.createdAt,
        };
      })
      .filter((r) => !onlyOpen || Number(r.remaining) > 0);

    return out;
  });

  // Create vendor advance (posts a JE)
  // POST /companies/:companyId/vendor-advances
  fastify.post('/companies/:companyId/vendor-advances', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    requireAnyRole(request as any, reply as any, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');

    const idempotencyKey = (request.headers as any)?.['idempotency-key'] as string | undefined;
    if (!idempotencyKey) {
      reply.status(400);
      return { error: 'Idempotency-Key header is required' };
    }

    const body = (request.body ?? {}) as {
      vendorId?: number;
      locationId?: number;
      warehouseId?: number;
      advanceDate?: string;
      currency?: string;
      amount?: number;
      bankAccountId?: number; // liquidity account (ASSET)
      receivedVia?: BankingAccountKind;
      reference?: string;
      description?: string;
    };

    const vendorId = Number(body.vendorId);
    if (!vendorId || Number.isNaN(vendorId)) {
      reply.status(400);
      return { error: 'vendorId is required' };
    }

    const cfg = await ensureInventoryCompanyDefaults(prisma as any, companyId);
    const locationId = Number(body.locationId ?? body.warehouseId ?? (cfg as any).defaultLocationId);
    if (!locationId || Number.isNaN(locationId)) {
      reply.status(400);
      return { error: 'locationId is required (or set company defaultLocationId)' };
    }

    const bankAccountId = Number(body.bankAccountId);
    if (!bankAccountId || Number.isNaN(bankAccountId)) {
      reply.status(400);
      return { error: 'bankAccountId is required' };
    }

    if (body.amount == null) {
      reply.status(400);
      return { error: 'amount is required' };
    }
    const amount = toMoneyDecimal(body.amount);
    if (amount.lessThanOrEqualTo(0)) {
      reply.status(400);
      return { error: 'amount must be > 0' };
    }

    const advanceDate = parseDateInput(body.advanceDate) ?? new Date();
    if (body.advanceDate && isNaN(advanceDate.getTime())) {
      reply.status(400);
      return { error: 'invalid advanceDate' };
    }

    const correlationId = randomUUID();
    const occurredAt = isoNow();
    const lockKey = `lock:vendor-advance:create:${companyId}:${vendorId}`;

    try {
      const { response: result } = await withLockBestEffort(redis, lockKey, 30_000, async () =>
        runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
          const txResult = await prisma.$transaction(async (tx: any) => {
            const vendor = await tx.vendor.findFirst({ where: { id: vendorId, companyId }, select: { id: true, name: true } });
            if (!vendor) throw Object.assign(new Error('vendor not found'), { statusCode: 404 });

            const loc = await tx.location.findFirst({ where: { id: locationId, companyId }, select: { id: true, name: true } });
            if (!loc) throw Object.assign(new Error('location not found'), { statusCode: 404 });

            const bankAcc = await tx.account.findFirst({ where: { id: bankAccountId, companyId }, select: { id: true, type: true } });
            if (!bankAcc) throw Object.assign(new Error('bankAccountId not found in this company'), { statusCode: 400 });
            if (bankAcc.type !== AccountType.ASSET) {
              throw Object.assign(new Error('bankAccountId must be an ASSET account'), { statusCode: 400 });
            }

            const prepaymentAccountId = await ensureVendorPrepaymentAccount(tx, companyId);

            const receivedVia = body.receivedVia ?? null;
            const reference = body.reference ? String(body.reference).trim() : null;
            const descriptionRaw = body.description ? String(body.description).trim() : '';
            const receivedViaLabel = receivedVia ? ` (${receivedVia.replace('_', '-')})` : '';
            const description = `Vendor advance • ${vendor.name}${receivedViaLabel}${descriptionRaw ? ` — ${descriptionRaw}` : ''}`.trim();

            const adv = await tx.vendorAdvance.create({
              data: {
                companyId,
                vendorId,
                locationId,
                advanceDate,
                currency: body.currency ?? null,
                amount,
                amountApplied: new Prisma.Decimal(0),
                bankAccountId,
                prepaymentAccountId,
                receivedVia,
                reference,
                description: descriptionRaw || null,
                createdByUserId: (request as any).user?.userId ?? null,
              } as any,
            });

            const je = await postJournalEntry(tx, {
              companyId,
              date: advanceDate,
              description,
              locationId,
              createdByUserId: (request as any).user?.userId ?? null,
              lines: [
                { accountId: prepaymentAccountId, debit: amount, credit: new Prisma.Decimal(0) },
                { accountId: bankAccountId, debit: new Prisma.Decimal(0), credit: amount },
              ],
              skipAccountValidation: true,
            });

            await tx.vendorAdvance.updateMany({
              where: { id: adv.id, companyId },
              data: { journalEntryId: je.id } as any,
            });

            const jeEventId = randomUUID();
            await tx.event.create({
              data: {
                companyId,
                eventId: jeEventId,
                eventType: 'journal.entry.created',
                type: 'JournalEntryCreated',
                schemaVersion: 'v1',
                occurredAt: new Date(occurredAt),
                source: 'cashflow-api',
                partitionKey: String(companyId),
                correlationId,
                aggregateType: 'JournalEntry',
                aggregateId: String(je.id),
                payload: { journalEntryId: je.id, companyId, source: 'VendorAdvance', vendorAdvanceId: adv.id },
              },
            });

            await writeAuditLog(tx as any, {
              companyId,
              userId: (request as any).user?.userId ?? null,
              action: 'vendor_advance.create',
              entityType: 'VendorAdvance',
              entityId: String(adv.id),
              idempotencyKey,
              correlationId,
              metadata: {
                vendorId,
                amount: amount.toString(),
                advanceDate,
                journalEntryId: je.id,
                occurredAt,
              },
            });

            return { vendorAdvanceId: adv.id, journalEntryId: je.id, jeEventId };
          });

          return { ...txResult, _correlationId: correlationId, _occurredAt: occurredAt };
        }, redis)
      );

      if ((result as any).jeEventId) {
        publishEventsFastPath([(result as any).jeEventId]);
      }

      return { vendorAdvanceId: (result as any).vendorAdvanceId, journalEntryId: (result as any).journalEntryId };
    } catch (err: any) {
      if (err?.statusCode) {
        reply.status(err.statusCode);
        return { error: err.message };
      }
      throw err;
    }
  });

  // Apply a vendor advance to a purchase bill (posts a JE: Dr AP, Cr Vendor Prepayments)
  // POST /companies/:companyId/purchase-bills/:purchaseBillId/apply-vendor-advance
  fastify.post('/companies/:companyId/purchase-bills/:purchaseBillId/apply-vendor-advance', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    requireAnyRole(request as any, reply as any, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
    const purchaseBillId = Number((request.params as any)?.purchaseBillId);
    if (!companyId || Number.isNaN(purchaseBillId)) {
      reply.status(400);
      return { error: 'invalid companyId or purchaseBillId' };
    }

    const idempotencyKey = (request.headers as any)?.['idempotency-key'] as string | undefined;
    if (!idempotencyKey) {
      reply.status(400);
      return { error: 'Idempotency-Key header is required' };
    }

    const body = (request.body ?? {}) as { vendorAdvanceId?: number; amount?: number; appliedDate?: string };
    const vendorAdvanceId = Number(body.vendorAdvanceId);
    if (!vendorAdvanceId || Number.isNaN(vendorAdvanceId)) {
      reply.status(400);
      return { error: 'vendorAdvanceId is required' };
    }
    if (body.amount == null) {
      reply.status(400);
      return { error: 'amount is required' };
    }
    const amount = toMoneyDecimal(body.amount);
    if (amount.lessThanOrEqualTo(0)) {
      reply.status(400);
      return { error: 'amount must be > 0' };
    }

    const appliedDate = parseDateInput(body.appliedDate) ?? new Date();
    if (body.appliedDate && isNaN(appliedDate.getTime())) {
      reply.status(400);
      return { error: 'invalid appliedDate' };
    }

    const correlationId = randomUUID();
    const occurredAt = isoNow();
    const lockKey = `lock:purchase-bill:apply-vendor-advance:${companyId}:${purchaseBillId}`;

    try {
      const { response: result } = await withLockBestEffort(redis, lockKey, 30_000, async () =>
        runIdempotentRequest(prisma, companyId, idempotencyKey, async () => {
          const txResult = await prisma.$transaction(async (tx: any) => {
            await tx.$queryRaw`
              SELECT id FROM PurchaseBill
              WHERE id = ${purchaseBillId} AND companyId = ${companyId}
              FOR UPDATE
            `;

            const bill = await tx.purchaseBill.findFirst({
              where: { id: purchaseBillId, companyId },
              select: { id: true, status: true, total: true, vendorId: true, billNumber: true, locationId: true },
            });
            if (!bill) throw Object.assign(new Error('purchase bill not found'), { statusCode: 404 });
            if (bill.status !== 'POSTED' && bill.status !== 'PARTIAL') {
              throw Object.assign(new Error('vendor advances can be applied only to POSTED or PARTIAL bills'), { statusCode: 400 });
            }

            const adv = await tx.vendorAdvance.findFirst({
              where: { id: vendorAdvanceId, companyId },
              select: { id: true, vendorId: true, amount: true, amountApplied: true, prepaymentAccountId: true },
            });
            if (!adv) throw Object.assign(new Error('vendor advance not found'), { statusCode: 404 });
            if (bill.vendorId && adv.vendorId && bill.vendorId !== adv.vendorId) {
              throw Object.assign(new Error('vendor advance vendor does not match bill vendor'), { statusCode: 400 });
            }

            // Remaining advance
            const appliedAggForAdv = await tx.vendorAdvanceApplication.aggregate({
              where: { companyId, vendorAdvanceId: adv.id },
              _sum: { amount: true },
            });
            const appliedSoFar = (appliedAggForAdv._sum.amount ?? new Prisma.Decimal(0)).toDecimalPlaces(2);
            const remainingAdv = new Prisma.Decimal(adv.amount).sub(appliedSoFar).toDecimalPlaces(2);
            if (amount.greaterThan(remainingAdv)) {
              throw Object.assign(new Error(`amount cannot exceed remaining vendor advance of ${remainingAdv.toString()}`), {
                statusCode: 400,
              });
            }

            // Remaining bill balance considering: payments + vendor credits + vendor advances
            const paymentsAgg = await tx.purchaseBillPayment.aggregate({
              where: { purchaseBillId: bill.id, companyId, reversedAt: null },
              _sum: { amount: true },
            });
            const paid = (paymentsAgg._sum.amount ?? new Prisma.Decimal(0)).toDecimalPlaces(2);

            const vcAgg = await tx.vendorCreditApplication.aggregate({
              where: { purchaseBillId: bill.id, companyId },
              _sum: { amount: true },
            });
            const creditsApplied = (vcAgg._sum.amount ?? new Prisma.Decimal(0)).toDecimalPlaces(2);

            const advAgg = await tx.vendorAdvanceApplication.aggregate({
              where: { purchaseBillId: bill.id, companyId },
              _sum: { amount: true },
            });
            const advancesApplied = (advAgg._sum.amount ?? new Prisma.Decimal(0)).toDecimalPlaces(2);

            const settled = paid.add(creditsApplied).add(advancesApplied).toDecimalPlaces(2);
            const remainingBill = new Prisma.Decimal(bill.total).sub(settled).toDecimalPlaces(2);
            if (amount.greaterThan(remainingBill)) {
              throw Object.assign(new Error(`amount cannot exceed remaining bill balance of ${remainingBill.toString()}`), {
                statusCode: 400,
              });
            }

            const apAccountId = await ensureAccountsPayableAccount(tx, companyId);
            const prepaymentAccountId = Number(adv.prepaymentAccountId);

            const je = await postJournalEntry(tx, {
              companyId,
              date: appliedDate,
              description: `Apply vendor advance to bill • ${bill.billNumber}`,
              locationId: bill.locationId ?? null,
              createdByUserId: (request as any).user?.userId ?? null,
              lines: [
                { accountId: apAccountId, debit: amount, credit: new Prisma.Decimal(0) },
                { accountId: prepaymentAccountId, debit: new Prisma.Decimal(0), credit: amount },
              ],
              skipAccountValidation: true,
            });

            const app = await tx.vendorAdvanceApplication.create({
              data: {
                companyId,
                vendorAdvanceId: adv.id,
                purchaseBillId: bill.id,
                appliedDate,
                amount,
                journalEntryId: je.id,
                createdByUserId: (request as any).user?.userId ?? null,
              } as any,
            });

            // Update bill status + amountPaid
            const newSettled = settled.add(amount).toDecimalPlaces(2);
            const newStatus = newSettled.greaterThanOrEqualTo(bill.total) ? 'PAID' : 'PARTIAL';
            await tx.purchaseBill.updateMany({
              where: { id: bill.id, companyId },
              data: { amountPaid: newSettled, status: newStatus } as any,
            });

            // Update vendor advance amountApplied
            const newApplied = appliedSoFar.add(amount).toDecimalPlaces(2);
            await tx.vendorAdvance.updateMany({
              where: { id: adv.id, companyId },
              data: { amountApplied: newApplied } as any,
            });

            const jeEventId = randomUUID();
            await tx.event.create({
              data: {
                companyId,
                eventId: jeEventId,
                eventType: 'journal.entry.created',
                type: 'JournalEntryCreated',
                schemaVersion: 'v1',
                occurredAt: new Date(occurredAt),
                source: 'cashflow-api',
                partitionKey: String(companyId),
                correlationId,
                aggregateType: 'JournalEntry',
                aggregateId: String(je.id),
                payload: { journalEntryId: je.id, companyId, source: 'VendorAdvanceApplication', vendorAdvanceApplicationId: app.id },
              },
            });

            await writeAuditLog(tx as any, {
              companyId,
              userId: (request as any).user?.userId ?? null,
              action: 'purchase_bill.vendor_advance.apply',
              entityType: 'VendorAdvanceApplication',
              entityId: String(app.id),
              idempotencyKey,
              correlationId,
              metadata: {
                purchaseBillId: bill.id,
                billNumber: bill.billNumber,
                vendorAdvanceId: adv.id,
                amount: amount.toString(),
                appliedDate,
                journalEntryId: je.id,
                newStatus,
                occurredAt,
              },
            });

            return { purchaseBillId: bill.id, vendorAdvanceApplicationId: app.id, journalEntryId: je.id, status: newStatus, jeEventId };
          });

          return { ...txResult, _correlationId: correlationId, _occurredAt: occurredAt };
        }, redis)
      );

      if ((result as any).jeEventId) {
        publishEventsFastPath([(result as any).jeEventId]);
      }

      return {
        purchaseBillId: (result as any).purchaseBillId,
        vendorAdvanceApplicationId: (result as any).vendorAdvanceApplicationId,
        journalEntryId: (result as any).journalEntryId,
        status: (result as any).status,
      };
    } catch (err: any) {
      if (err?.statusCode) {
        reply.status(err.statusCode);
        return { error: err.message };
      }
      throw err;
    }
  });
}

