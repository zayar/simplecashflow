import { AccountType, ItemType, Prisma } from '@prisma/client';
import { toMoneyDecimal } from '../../utils/money.js';
import { isoNow, parseDateInput } from '../../utils/date.js';
import { assertTotalsMatchStored, buildInvoicePostingJournalLines, computeInvoiceTotalsAndIncomeBuckets } from '../books/invoiceAccounting.js';
import { postJournalEntry } from '../ledger/posting.service.js';
import { writeAuditLog } from '../../infrastructure/auditLog.js';
import { randomUUID } from 'node:crypto';

type Tx = any;

async function ensureSalesIncomeAccount(tx: Tx, companyId: number): Promise<number> {
  const existing = await tx.account.findFirst({
    where: { companyId, code: '4000', type: AccountType.INCOME },
    select: { id: true },
  });
  if (existing?.id) return existing.id;

  const created = await tx.account.create({
    data: {
      companyId,
      code: '4000',
      name: 'Sales Income',
      type: AccountType.INCOME,
      normalBalance: 'CREDIT',
      reportGroup: 'SALES_REVENUE',
      cashflowActivity: 'OPERATING',
    },
    select: { id: true },
  });
  return created.id;
}

async function ensureCashAccount1000(tx: Tx, companyId: number): Promise<number> {
  const existing = await tx.account.findFirst({
    where: { companyId, code: '1000', type: AccountType.ASSET },
    select: { id: true },
  });
  if (existing?.id) return existing.id;

  // Company creation usually seeds this; we self-heal for integrations.
  const created = await tx.account.create({
    data: {
      companyId,
      code: '1000',
      name: 'Cash on Hand',
      type: AccountType.ASSET,
      normalBalance: 'DEBIT',
      reportGroup: 'CASH_AND_CASH_EQUIVALENTS',
      cashflowActivity: 'OPERATING',
    },
    select: { id: true },
  });
  return created.id;
}

async function ensureTaxPayable2100IfNeeded(tx: Tx, companyId: number, taxAmount: Prisma.Decimal): Promise<number | null> {
  if (!taxAmount || !taxAmount.greaterThan(0)) return null;
  const existing = await tx.account.findFirst({
    where: { companyId, type: AccountType.LIABILITY, code: '2100' },
    select: { id: true },
  });
  if (existing?.id) return existing.id;
  const created = await tx.account.create({
    data: {
      companyId,
      code: '2100',
      name: 'Tax Payable',
      type: AccountType.LIABILITY,
      normalBalance: 'CREDIT',
      reportGroup: 'OTHER_CURRENT_LIABILITY',
      cashflowActivity: 'OPERATING',
    },
    select: { id: true },
  });
  return created.id;
}

export type PitiSaleUpsertRequest = {
  saleId: string;
  saleNumber?: string;
  saleDate?: string; // ISO or YYYY-MM-DD
  currency?: string | null;

  customer?: {
    externalCustomerId?: string;
    name: string;
    phone?: string | null;
    email?: string | null;
  } | null;

  lines: Array<{
    externalProductId?: string;
    sku?: string | null;
    name: string;
    quantity: number;
    unitPrice: number;
    discountAmount?: number | null;
    taxRate?: number | null; // 0..1
  }>;

  payments?: Array<{
    // If omitted, we default to Cash (Account code 1000).
    cashflowAccountId?: number;
    cashflowAccountCode?: string;
    amount: number;
    paidAt?: string;
  }> | null;

  options?: {
    autoCreateCustomer?: boolean; // default true
    autoCreateItems?: boolean; // default true
    postInvoice?: boolean; // default true
    recordPayment?: boolean; // default true when payments provided
  };
};

export type PitiSaleUpsertResult = {
  saleId: string;
  invoiceId: number;
  invoiceNumber: string;
  invoiceStatus: string;
  journalEntryId: number | null;
  paymentIds: number[];
};

export type PitiRefundUpsertRequest = {
  refundId: string;
  saleId?: string | null; // used to link to the original invoice when available
  refundNumber?: string;
  refundDate?: string;
  currency?: string | null;

  customer?: {
    externalCustomerId?: string;
    name: string;
    phone?: string | null;
    email?: string | null;
  } | null;

  lines: Array<{
    externalProductId?: string;
    sku?: string | null;
    name: string;
    quantity: number;
    unitPrice: number;
    discountAmount?: number | null;
    taxRate?: number | null; // 0..1
  }>;
};

export type PitiRefundUpsertResult = {
  refundId: string;
  creditNoteId: number;
  creditNoteNumber: string;
  status: string;
  journalEntryId: number | null;
};

/**
 * Creates (or replays) a posted Cashflow Invoice from a Piti COMPLETED sale.
 *
 * Inventory policy:
 * - We DO create/reuse `Item` records for reporting.
 * - We ALWAYS force `trackInventory=false` for integration-created items to avoid Cashflow stock moves
 *   (Piti remains SoT for operational inventory).
 */
export async function upsertPostedInvoiceFromPitiSale(args: {
  prisma: any;
  companyId: number;
  idempotencyKey: string;
  payload: PitiSaleUpsertRequest;
  userId?: number | null;
}): Promise<PitiSaleUpsertResult> {
  const { prisma, companyId, payload } = args;

  if (!payload.saleId || !String(payload.saleId).trim()) throw new Error('saleId is required');
  if (!payload.lines || payload.lines.length === 0) throw new Error('at least one line is required');

  const saleDate = parseDateInput(payload.saleDate ?? null) ?? new Date();

  const result = await prisma.$transaction(async (tx: Tx) => {
    // Hard de-dupe by external sale id (independent from idempotency key).
    const existingMap = await tx.integrationEntityMap.findFirst({
      where: { companyId, integration: 'piti', entityType: 'Sale', externalId: String(payload.saleId) },
      select: { internalId: true },
    });
    if (existingMap?.internalId) {
      const invoiceId = Number(existingMap.internalId);
      const inv = await tx.invoice.findFirst({
        where: { id: invoiceId, companyId },
        select: { id: true, invoiceNumber: true, status: true, journalEntryId: true },
      });
      if (!inv) throw new Error('integration mapping exists but invoice not found');
      const payments = await tx.payment.findMany({ where: { invoiceId: inv.id, companyId }, select: { id: true } });
      return {
        saleId: payload.saleId,
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        invoiceStatus: inv.status,
        journalEntryId: inv.journalEntryId ?? null,
        paymentIds: payments.map((p: any) => p.id),
      } satisfies PitiSaleUpsertResult;
    }

    const company = await tx.company.findFirst({
      where: { id: companyId },
      select: { id: true, baseCurrency: true, accountsReceivableAccountId: true },
    });
    if (!company) throw new Error('company not found');
    if (!company.accountsReceivableAccountId) throw new Error('company.accountsReceivableAccountId is not set');

    // Ensure AR account is valid
    const arAccount = await tx.account.findFirst({
      where: { id: company.accountsReceivableAccountId, companyId, type: AccountType.ASSET },
      select: { id: true },
    });
    if (!arAccount) throw new Error('accountsReceivableAccountId must be an ASSET account in this company');

    const salesIncomeAccountId = await ensureSalesIncomeAccount(tx, companyId);

    // Customer mapping (best-effort)
    const autoCreateCustomer = payload.options?.autoCreateCustomer ?? true;
    const customerName = payload.customer?.name ? String(payload.customer.name).trim() : 'Walk-in Customer';
    const customerExtId = payload.customer?.externalCustomerId ? String(payload.customer.externalCustomerId).trim() : null;

    let customerId: number | null = null;
    if (customerExtId) {
      const cm = await tx.integrationEntityMap.findFirst({
        where: { companyId, integration: 'piti', entityType: 'Customer', externalId: customerExtId },
        select: { internalId: true },
      });
      if (cm?.internalId) customerId = Number(cm.internalId);
    }
    if (!customerId && payload.customer?.phone) {
      // NOTE: Cashflow Customer has no unique phone/email; we just attempt a match for convenience.
      const found = await tx.customer.findFirst({
        where: { companyId, phone: String(payload.customer.phone) },
        select: { id: true },
      });
      if (found?.id) customerId = found.id;
    }
    if (!customerId) {
      if (!autoCreateCustomer) throw new Error('customer not mapped and autoCreateCustomer=false');
      const createdCustomer = await tx.customer.create({
        data: {
          companyId,
          name: customerName,
          phone: payload.customer?.phone ? String(payload.customer.phone) : null,
          email: payload.customer?.email ? String(payload.customer.email) : null,
          currency: (payload.currency ?? null) ? String(payload.currency).trim().toUpperCase() : null,
        },
        select: { id: true },
      });
      customerId = createdCustomer.id;
      if (customerExtId) {
        await tx.integrationEntityMap.create({
          data: {
            companyId,
            integration: 'piti',
            entityType: 'Customer',
            externalId: customerExtId,
            internalId: String(customerId),
            metadata: { createdAt: isoNow(), name: customerName },
          },
        });
      }
    }

    const autoCreateItems = payload.options?.autoCreateItems ?? true;

    // Resolve/Create items and compute invoice lines
    const computedLines: any[] = [];
    for (const l of payload.lines) {
      if (!l || !l.quantity || l.quantity <= 0) throw new Error('each line must have quantity > 0');
      if (!l.unitPrice || l.unitPrice <= 0) throw new Error('each line must have unitPrice > 0');

      const extProductId = l.externalProductId ? String(l.externalProductId).trim() : null;
      const sku = l.sku ? String(l.sku).trim() : null;

      let item: any | null = null;

      // 1) mapping by externalProductId
      if (extProductId) {
        const map = await tx.integrationEntityMap.findFirst({
          where: { companyId, integration: 'piti', entityType: 'Item', externalId: extProductId },
          select: { internalId: true },
        });
        if (map?.internalId) {
          item = await tx.item.findFirst({ where: { id: Number(map.internalId), companyId } });
        }
      }

      // 2) fallback by sku within Cashflow
      if (!item && sku) {
        item = await tx.item.findFirst({ where: { companyId, sku } });
      }

      // 3) auto-create
      if (!item) {
        if (!autoCreateItems) throw new Error(`item not mapped for externalProductId=${extProductId ?? 'null'} sku=${sku ?? 'null'}`);
        item = await tx.item.create({
          data: {
            companyId,
            name: String(l.name ?? 'Item').trim(),
            sku,
            type: ItemType.GOODS,
            sellingPrice: toMoneyDecimal(l.unitPrice),
            costPrice: null,
            trackInventory: false, // IMPORTANT: do not let Cashflow manage POS stock
            incomeAccountId: salesIncomeAccountId,
            expenseAccountId: null,
          },
        });
        if (extProductId) {
          await tx.integrationEntityMap.create({
            data: {
              companyId,
              integration: 'piti',
              entityType: 'Item',
              externalId: extProductId,
              internalId: String(item.id),
              metadata: { createdAt: isoNow(), sku, name: item.name },
            },
          });
        }
      }

      const qty = toMoneyDecimal(l.quantity);
      const unit = toMoneyDecimal(l.unitPrice);
      const discount = toMoneyDecimal(Number(l.discountAmount ?? 0));
      const rate = new Prisma.Decimal(Number(l.taxRate ?? 0)).toDecimalPlaces(4);
      if (rate.lessThan(0) || rate.greaterThan(1)) throw new Error('taxRate must be between 0 and 1');

      const lineSubtotal = qty.mul(unit).toDecimalPlaces(2);
      if (discount.lessThan(0) || discount.greaterThan(lineSubtotal)) throw new Error('discountAmount must be between 0 and line subtotal');
      const netSubtotal = lineSubtotal.sub(discount).toDecimalPlaces(2);
      const lineTax = netSubtotal.mul(rate).toDecimalPlaces(2);

      computedLines.push({
        companyId,
        itemId: item.id,
        description: String(l.name ?? item.name).trim(),
        quantity: qty,
        unitPrice: unit,
        discountAmount: discount,
        lineTotal: netSubtotal, // stored as net subtotal for backwards compatibility
        taxRate: rate,
        taxAmount: lineTax,
        incomeAccountId: salesIncomeAccountId,
      });
    }

    // Invoice totals
    const linesForMath = computedLines.map((l: any) => ({
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discountAmount: l.discountAmount ?? 0,
      taxRate: l.taxRate ?? 0,
      incomeAccountId: Number(l.incomeAccountId),
    }));
    const computed = computeInvoiceTotalsAndIncomeBuckets(linesForMath);
    const subtotal = new Prisma.Decimal(computed.subtotal);
    const taxAmount = new Prisma.Decimal(computed.taxAmount);
    const total = new Prisma.Decimal(computed.total);
    const incomeBuckets = new Map<number, Prisma.Decimal>(
      Array.from(computed.incomeBuckets.entries()).map(([k, v]) => [k, new Prisma.Decimal(v)])
    );

    const occurredAt = isoNow();
    const correlationId = randomUUID();

    // Create invoice (POSTED)
    const invoiceNumber = `INV-PITI-${String(payload.saleNumber ?? payload.saleId).replace(/\s+/g, '-')}`;
    const inv = await tx.invoice.create({
      data: {
        companyId,
        customerId,
        invoiceNumber,
        status: 'POSTED',
        invoiceDate: saleDate,
        dueDate: null,
        currency: payload.currency ? String(payload.currency).trim().toUpperCase() : null,
        subtotal: subtotal.toDecimalPlaces(2),
        taxAmount: taxAmount.toDecimalPlaces(2),
        total: total.toDecimalPlaces(2),
        amountPaid: new Prisma.Decimal(0),
        customerNotes: `Imported from Piti saleId=${payload.saleId}`,
        termsAndConditions: null,
        lines: { create: computedLines },
      },
      include: { lines: true },
    });

    // Post JE for invoice
    const taxPayableAccountId = await ensureTaxPayable2100IfNeeded(tx, companyId, taxAmount);
    const jeLines = buildInvoicePostingJournalLines({
      arAccountId: company.accountsReceivableAccountId,
      total,
      incomeBuckets: incomeBuckets as any,
      taxPayableAccountId,
      taxAmount,
      // inventory intentionally omitted for Piti integration
    }).map((l) => ({
      accountId: l.accountId,
      debit: new Prisma.Decimal(l.debit).toDecimalPlaces(2),
      credit: new Prisma.Decimal(l.credit).toDecimalPlaces(2),
    }));

    // sanity: debits == credits
    const d = jeLines.reduce((s: Prisma.Decimal, l: any) => s.add(l.debit), new Prisma.Decimal(0)).toDecimalPlaces(2);
    const c = jeLines.reduce((s: Prisma.Decimal, l: any) => s.add(l.credit), new Prisma.Decimal(0)).toDecimalPlaces(2);
    if (!d.equals(c)) throw new Error('journal entry imbalance');

    const journalEntry = await postJournalEntry(tx, {
      companyId,
      date: saleDate,
      description: `Piti sale ${payload.saleNumber ?? payload.saleId}`,
      createdByUserId: args.userId ?? null,
      lines: jeLines,
    });

    // Ensure totals match stored invoice total (guardrail)
    assertTotalsMatchStored(total as any, new Prisma.Decimal(inv.total) as any);

    await tx.invoice.update({
      where: { id: inv.id },
      data: { journalEntryId: journalEntry.id } as any,
    });

    await writeAuditLog(tx, {
      companyId,
      userId: args.userId ?? null,
      action: 'integration.piti.sale.import',
      entityType: 'Invoice',
      entityId: inv.id,
      idempotencyKey: args.idempotencyKey,
      correlationId,
      metadata: {
        saleId: payload.saleId,
        saleNumber: payload.saleNumber ?? null,
        invoiceId: inv.id,
        journalEntryId: journalEntry.id,
        subtotal: subtotal.toString(),
        taxAmount: taxAmount.toString(),
        total: total.toString(),
      },
    });

    // Outbox events (worker projections + downstream hooks)
    const jeEventId = randomUUID();
    await tx.event.create({
      data: {
        companyId,
        eventId: jeEventId,
        eventType: 'journal.entry.created',
        schemaVersion: 'v1',
        occurredAt: new Date(occurredAt),
        source: 'cashflow-api',
        partitionKey: String(companyId),
        correlationId,
        aggregateType: 'JournalEntry',
        aggregateId: String(journalEntry.id),
        type: 'JournalEntryCreated',
        payload: { journalEntryId: journalEntry.id, companyId },
      },
    });

    const invoiceEventId = randomUUID();
    await tx.event.create({
      data: {
        companyId,
        eventId: invoiceEventId,
        eventType: 'invoice.posted',
        schemaVersion: 'v1',
        occurredAt: new Date(occurredAt),
        source: 'cashflow-api',
        partitionKey: String(companyId),
        correlationId,
        aggregateType: 'Invoice',
        aggregateId: String(inv.id),
        type: 'InvoicePosted',
        payload: { invoiceId: inv.id, journalEntryId: journalEntry.id, total: total.toString(), customerId },
      },
    });

    // Save mapping saleId -> invoiceId
    await tx.integrationEntityMap.create({
      data: {
        companyId,
        integration: 'piti',
        entityType: 'Sale',
        externalId: String(payload.saleId),
        internalId: String(inv.id),
        metadata: {
          saleNumber: payload.saleNumber ?? null,
          invoiceNumber,
          createdAt: occurredAt,
        },
      },
    });

    // Optional payment(s)
    const paymentIds: number[] = [];
    const recordPayment = payload.options?.recordPayment ?? true;
    const payments = payload.payments ?? [];

    if (recordPayment && payments.length > 0) {
      for (const p of payments) {
        const amt = toMoneyDecimal(p.amount);
        if (amt.lessThanOrEqualTo(0)) throw new Error('payment.amount must be > 0');

        let bankAccountId: number | null = null;
        if (p.cashflowAccountId) {
          bankAccountId = Number(p.cashflowAccountId);
        } else if (p.cashflowAccountCode) {
          const a = await tx.account.findFirst({
            where: { companyId, code: String(p.cashflowAccountCode).trim(), type: AccountType.ASSET },
            select: { id: true },
          });
          bankAccountId = a?.id ?? null;
        } else {
          bankAccountId = await ensureCashAccount1000(tx, companyId);
        }

        const bankAccount = await tx.account.findFirst({
          where: { id: bankAccountId, companyId, type: AccountType.ASSET },
          select: { id: true },
        });
        if (!bankAccount) throw new Error('payment bank/cash account must be an ASSET account in this company');

        const paymentDate = parseDateInput(p.paidAt ?? null) ?? saleDate;

        // Payment JE: Dr Bank/Cash, Cr AR
        const payJe = await postJournalEntry(tx, {
          companyId,
          date: paymentDate,
          description: `Piti payment for sale ${payload.saleNumber ?? payload.saleId}`,
          createdByUserId: args.userId ?? null,
          lines: [
            { accountId: bankAccount.id, debit: amt, credit: new Prisma.Decimal(0) },
            { accountId: company.accountsReceivableAccountId, debit: new Prisma.Decimal(0), credit: amt },
          ],
        });

        const payment = await tx.payment.create({
          data: {
            companyId,
            invoiceId: inv.id,
            paymentDate,
            amount: amt,
            bankAccountId: bankAccount.id,
            journalEntryId: payJe.id,
          },
          select: { id: true, amount: true },
        });
        paymentIds.push(payment.id);

        await writeAuditLog(tx, {
          companyId,
          userId: args.userId ?? null,
          action: 'integration.piti.payment.import',
          entityType: 'Payment',
          entityId: payment.id,
          idempotencyKey: args.idempotencyKey,
          correlationId,
          metadata: {
            saleId: payload.saleId,
            invoiceId: inv.id,
            paymentId: payment.id,
            paymentDate,
            amount: amt.toString(),
            bankAccountId: bankAccount.id,
            journalEntryId: payJe.id,
          },
        });

        // Update invoice paid amount + status
        const paidTotal = await tx.payment.aggregate({
          where: { companyId, invoiceId: inv.id, reversedAt: null },
          _sum: { amount: true },
        });
        const newPaid = new Prisma.Decimal(paidTotal?._sum?.amount ?? 0).toDecimalPlaces(2);

        const newStatus = newPaid.greaterThanOrEqualTo(total) ? 'PAID' : newPaid.greaterThan(0) ? 'PARTIAL' : 'POSTED';
        await tx.invoice.update({
          where: { id: inv.id },
          data: { amountPaid: newPaid, status: newStatus } as any,
        });

        // Event: journal.entry.created (payment)
        const payJeEventId = randomUUID();
        await tx.event.create({
          data: {
            companyId,
            eventId: payJeEventId,
            eventType: 'journal.entry.created',
            schemaVersion: 'v1',
            occurredAt: new Date(occurredAt),
            source: 'cashflow-api',
            partitionKey: String(companyId),
            correlationId,
            aggregateType: 'JournalEntry',
            aggregateId: String(payJe.id),
            type: 'JournalEntryCreated',
            payload: { journalEntryId: payJe.id, companyId },
          },
        });

        const paymentEventId = randomUUID();
        await tx.event.create({
          data: {
            companyId,
            eventId: paymentEventId,
            eventType: 'payment.recorded',
            schemaVersion: 'v1',
            occurredAt: new Date(occurredAt),
            source: 'cashflow-api',
            partitionKey: String(companyId),
            correlationId,
            aggregateType: 'Payment',
            aggregateId: String(payment.id),
            type: 'PaymentRecorded',
            payload: {
              paymentId: payment.id,
              invoiceId: inv.id,
              journalEntryId: payJe.id,
              amount: amt.toString(),
              bankAccountId: bankAccount.id,
            },
          },
        });
      }
    }

    const updated = await tx.invoice.findFirst({
      where: { id: inv.id, companyId },
      select: { id: true, invoiceNumber: true, status: true, journalEntryId: true },
    });
    if (!updated) throw new Error('invoice not found after creation');

    return {
      saleId: payload.saleId,
      invoiceId: updated.id,
      invoiceNumber: updated.invoiceNumber,
      invoiceStatus: updated.status,
      journalEntryId: updated.journalEntryId ?? null,
      paymentIds,
    } satisfies PitiSaleUpsertResult;
  });

  return result;
}

/**
 * Creates (or replays) a posted Cashflow CreditNote from a Piti refund/return.
 *
 * Inventory policy:
 * - No stock moves (items are non-tracked).
 * - Finance only: reverse revenue + tax and reduce AR.
 */
export async function upsertPostedCreditNoteFromPitiRefund(args: {
  prisma: any;
  companyId: number;
  idempotencyKey: string;
  payload: PitiRefundUpsertRequest;
  userId?: number | null;
}): Promise<PitiRefundUpsertResult> {
  const { prisma, companyId, payload } = args;

  if (!payload.refundId || !String(payload.refundId).trim()) throw new Error('refundId is required');
  if (!payload.lines || payload.lines.length === 0) throw new Error('at least one line is required');

  const refundDate = parseDateInput(payload.refundDate ?? null) ?? new Date();

  return await prisma.$transaction(async (tx: Tx) => {
    const existingMap = await tx.integrationEntityMap.findFirst({
      where: { companyId, integration: 'piti', entityType: 'Refund', externalId: String(payload.refundId) },
      select: { internalId: true },
    });
    if (existingMap?.internalId) {
      const creditNoteId = Number(existingMap.internalId);
      const cn = await tx.creditNote.findFirst({
        where: { id: creditNoteId, companyId },
        select: { id: true, creditNoteNumber: true, status: true, journalEntryId: true },
      });
      if (!cn) throw new Error('integration mapping exists but credit note not found');
      return {
        refundId: payload.refundId,
        creditNoteId: cn.id,
        creditNoteNumber: cn.creditNoteNumber,
        status: cn.status,
        journalEntryId: cn.journalEntryId ?? null,
      } satisfies PitiRefundUpsertResult;
    }

    const company = await tx.company.findFirst({
      where: { id: companyId },
      select: { id: true, accountsReceivableAccountId: true },
    });
    if (!company) throw new Error('company not found');
    if (!company.accountsReceivableAccountId) throw new Error('company.accountsReceivableAccountId is not set');

    // Ensure AR account is valid
    const arAccount = await tx.account.findFirst({
      where: { id: company.accountsReceivableAccountId, companyId, type: AccountType.ASSET },
      select: { id: true },
    });
    if (!arAccount) throw new Error('accountsReceivableAccountId must be an ASSET account in this company');

    const salesIncomeAccountId = await ensureSalesIncomeAccount(tx, companyId);

    // Try to link to invoice via saleId mapping (optional)
    let invoiceId: number | null = null;
    if (payload.saleId) {
      const saleMap = await tx.integrationEntityMap.findFirst({
        where: { companyId, integration: 'piti', entityType: 'Sale', externalId: String(payload.saleId) },
        select: { internalId: true },
      });
      if (saleMap?.internalId) invoiceId = Number(saleMap.internalId);
    }

    // Resolve/create customer (same logic as sale import)
    const customerName = payload.customer?.name ? String(payload.customer.name).trim() : 'Walk-in Customer';
    const customerExtId = payload.customer?.externalCustomerId ? String(payload.customer.externalCustomerId).trim() : null;

    let customerId: number | null = null;
    if (customerExtId) {
      const cm = await tx.integrationEntityMap.findFirst({
        where: { companyId, integration: 'piti', entityType: 'Customer', externalId: customerExtId },
        select: { internalId: true },
      });
      if (cm?.internalId) customerId = Number(cm.internalId);
    }
    if (!customerId && payload.customer?.phone) {
      const found = await tx.customer.findFirst({
        where: { companyId, phone: String(payload.customer.phone) },
        select: { id: true },
      });
      if (found?.id) customerId = found.id;
    }
    if (!customerId) {
      const createdCustomer = await tx.customer.create({
        data: {
          companyId,
          name: customerName,
          phone: payload.customer?.phone ? String(payload.customer.phone) : null,
          email: payload.customer?.email ? String(payload.customer.email) : null,
          currency: (payload.currency ?? null) ? String(payload.currency).trim().toUpperCase() : null,
        },
        select: { id: true },
      });
      customerId = createdCustomer.id;
      if (customerExtId) {
        await tx.integrationEntityMap.create({
          data: {
            companyId,
            integration: 'piti',
            entityType: 'Customer',
            externalId: customerExtId,
            internalId: String(customerId),
            metadata: { createdAt: isoNow(), name: customerName },
          },
        });
      }
    }

    // Resolve/create items and compute credit note lines
    const computedLines: any[] = [];
    for (const l of payload.lines) {
      if (!l || !l.quantity || l.quantity <= 0) throw new Error('each line must have quantity > 0');
      if (!l.unitPrice || l.unitPrice <= 0) throw new Error('each line must have unitPrice > 0');

      const extProductId = l.externalProductId ? String(l.externalProductId).trim() : null;
      const sku = l.sku ? String(l.sku).trim() : null;

      let item: any | null = null;
      if (extProductId) {
        const map = await tx.integrationEntityMap.findFirst({
          where: { companyId, integration: 'piti', entityType: 'Item', externalId: extProductId },
          select: { internalId: true },
        });
        if (map?.internalId) item = await tx.item.findFirst({ where: { id: Number(map.internalId), companyId } });
      }
      if (!item && sku) item = await tx.item.findFirst({ where: { companyId, sku } });
      if (!item) {
        item = await tx.item.create({
          data: {
            companyId,
            name: String(l.name ?? 'Item').trim(),
            sku,
            type: ItemType.GOODS,
            sellingPrice: toMoneyDecimal(l.unitPrice),
            costPrice: null,
            trackInventory: false,
            incomeAccountId: salesIncomeAccountId,
            expenseAccountId: null,
          },
        });
        if (extProductId) {
          await tx.integrationEntityMap.create({
            data: {
              companyId,
              integration: 'piti',
              entityType: 'Item',
              externalId: extProductId,
              internalId: String(item.id),
              metadata: { createdAt: isoNow(), sku, name: item.name },
            },
          });
        }
      }

      const qty = toMoneyDecimal(l.quantity);
      const unit = toMoneyDecimal(l.unitPrice);
      const discount = toMoneyDecimal(Number(l.discountAmount ?? 0));
      const rate = new Prisma.Decimal(Number(l.taxRate ?? 0)).toDecimalPlaces(4);
      if (rate.lessThan(0) || rate.greaterThan(1)) throw new Error('taxRate must be between 0 and 1');

      const lineSubtotal = qty.mul(unit).toDecimalPlaces(2);
      if (discount.lessThan(0) || discount.greaterThan(lineSubtotal)) throw new Error('discountAmount must be between 0 and line subtotal');
      const netSubtotal = lineSubtotal.sub(discount).toDecimalPlaces(2);
      const lineTax = netSubtotal.mul(rate).toDecimalPlaces(2);

      computedLines.push({
        companyId,
        itemId: item.id,
        invoiceLineId: null,
        description: String(l.name ?? item.name).trim(),
        quantity: qty,
        unitPrice: unit,
        discountAmount: discount,
        lineTotal: netSubtotal,
        taxRate: rate,
        taxAmount: lineTax,
        incomeAccountId: salesIncomeAccountId,
      });
    }

    const linesForMath = computedLines.map((l: any) => ({
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discountAmount: l.discountAmount ?? 0,
      taxRate: l.taxRate ?? 0,
      incomeAccountId: Number(l.incomeAccountId),
    }));
    const computed = computeInvoiceTotalsAndIncomeBuckets(linesForMath);
    const subtotal = new Prisma.Decimal(computed.subtotal);
    const taxAmount = new Prisma.Decimal(computed.taxAmount);
    const total = new Prisma.Decimal(computed.total);
    const incomeBuckets = new Map<number, Prisma.Decimal>(
      Array.from(computed.incomeBuckets.entries()).map(([k, v]) => [k, new Prisma.Decimal(v)])
    );

    const occurredAt = isoNow();
    const correlationId = randomUUID();

    const creditNoteNumber = `CN-PITI-${String(payload.refundNumber ?? payload.refundId).replace(/\s+/g, '-')}`;
    const cn = await tx.creditNote.create({
      data: {
        companyId,
        invoiceId,
        customerId,
        creditNoteNumber,
        status: 'POSTED',
        creditNoteDate: refundDate,
        currency: payload.currency ? String(payload.currency).trim().toUpperCase() : null,
        subtotal: subtotal.toDecimalPlaces(2),
        taxAmount: taxAmount.toDecimalPlaces(2),
        total: total.toDecimalPlaces(2),
        lines: { create: computedLines },
      } as any,
    });

    const taxPayableAccountId = await ensureTaxPayable2100IfNeeded(tx, companyId, taxAmount);

    // JE for credit note:
    // - Debit income (reverse revenue)
    // - Debit tax payable (reverse tax liability)
    // - Credit AR (reduce receivable)
    const jeLines: Array<{ accountId: number; debit: Prisma.Decimal; credit: Prisma.Decimal }> = [];
    for (const [incomeAccountId, amt] of incomeBuckets.entries()) {
      jeLines.push({ accountId: incomeAccountId, debit: new Prisma.Decimal(amt).toDecimalPlaces(2), credit: new Prisma.Decimal(0) });
    }
    if (taxAmount.greaterThan(0)) {
      if (!taxPayableAccountId) throw new Error('taxPayableAccountId required when taxAmount > 0');
      jeLines.push({ accountId: taxPayableAccountId, debit: taxAmount.toDecimalPlaces(2), credit: new Prisma.Decimal(0) });
    }
    jeLines.push({ accountId: company.accountsReceivableAccountId, debit: new Prisma.Decimal(0), credit: total.toDecimalPlaces(2) });

    const debit = jeLines.reduce((s, l) => s.add(l.debit), new Prisma.Decimal(0)).toDecimalPlaces(2);
    const credit = jeLines.reduce((s, l) => s.add(l.credit), new Prisma.Decimal(0)).toDecimalPlaces(2);
    if (!debit.equals(credit)) throw new Error('journal entry imbalance');

    const je = await postJournalEntry(tx, {
      companyId,
      date: refundDate,
      description: `Piti refund ${payload.refundNumber ?? payload.refundId}`,
      createdByUserId: args.userId ?? null,
      lines: jeLines,
    });

    await tx.creditNote.update({ where: { id: cn.id }, data: { journalEntryId: je.id } as any });

    // Events
    const jeEventId = randomUUID();
    await tx.event.create({
      data: {
        companyId,
        eventId: jeEventId,
        eventType: 'journal.entry.created',
        schemaVersion: 'v1',
        occurredAt: new Date(occurredAt),
        source: 'cashflow-api',
        partitionKey: String(companyId),
        correlationId,
        aggregateType: 'JournalEntry',
        aggregateId: String(je.id),
        type: 'JournalEntryCreated',
        payload: { journalEntryId: je.id, companyId },
      },
    });

    const cnPostedEventId = randomUUID();
    await tx.event.create({
      data: {
        companyId,
        eventId: cnPostedEventId,
        eventType: 'credit_note.posted',
        schemaVersion: 'v1',
        occurredAt: new Date(occurredAt),
        source: 'cashflow-api',
        partitionKey: String(companyId),
        correlationId,
        aggregateType: 'CreditNote',
        aggregateId: String(cn.id),
        type: 'CreditNotePosted',
        payload: { creditNoteId: cn.id, journalEntryId: je.id, total: total.toString() },
      },
    });

    await writeAuditLog(tx, {
      companyId,
      userId: args.userId ?? null,
      action: 'integration.piti.refund.import',
      entityType: 'CreditNote',
      entityId: cn.id,
      idempotencyKey: args.idempotencyKey,
      correlationId,
      metadata: {
        refundId: payload.refundId,
        refundNumber: payload.refundNumber ?? null,
        saleId: payload.saleId ?? null,
        creditNoteId: cn.id,
        journalEntryId: je.id,
        subtotal: subtotal.toString(),
        taxAmount: taxAmount.toString(),
        total: total.toString(),
      },
    });

    await tx.integrationEntityMap.create({
      data: {
        companyId,
        integration: 'piti',
        entityType: 'Refund',
        externalId: String(payload.refundId),
        internalId: String(cn.id),
        metadata: {
          refundNumber: payload.refundNumber ?? null,
          saleId: payload.saleId ?? null,
          creditNoteNumber,
          createdAt: occurredAt,
        },
      },
    });

    return {
      refundId: payload.refundId,
      creditNoteId: cn.id,
      creditNoteNumber,
      status: 'POSTED',
      journalEntryId: je.id,
    } satisfies PitiRefundUpsertResult;
  });
}


