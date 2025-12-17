import type { FastifyInstance } from 'fastify';
import { prisma } from '../../infrastructure/db.js';
import {
  AccountReportGroup,
  AccountType,
  BankingAccountKind,
  CashflowActivity,
  NormalBalance,
} from '@prisma/client';
import { DEFAULT_ACCOUNTS } from './company.constants.js';
import {
  enforceCompanyScope,
  forbidClientProvidedCompanyId,
  getAuthCompanyId,
  requireCompanyIdParam,
} from '../../utils/tenant.js';

export async function companiesRoutes(fastify: FastifyInstance) {
  // Company endpoints are tenant scoped; require JWT.
  fastify.addHook('preHandler', fastify.authenticate);

  // List companies
  fastify.get('/companies', async (request) => {
    const companyId = getAuthCompanyId(request);
    // Return only the authenticated tenant's company.
    const company = await prisma.company.findUnique({
      where: { id: companyId },
    });
    return company ? [company] : [];
  });

  // Create company
  fastify.post('/companies', async (request, reply) => {
    // In production fintech: creating a company is part of onboarding (/register)
    // and should not be exposed as a general authenticated endpoint.
    reply.status(403);
    return { error: 'forbidden: use /register to create a company' };
  });

  // --- Company settings (Books layer) ---
  fastify.get('/companies/:companyId/settings', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);

    const company = await prisma.company.findUnique({
      where: { id: companyId },
      include: {
        accountsReceivableAccount: true,
        accountsPayableAccount: true,
        inventoryAssetAccount: true,
        cogsAccount: true,
        openingBalanceEquityAccount: true,
        defaultWarehouse: true,
      },
    });

    if (!company) {
      reply.status(404);
      return { error: 'company not found' };
    }

    // Used for base currency immutability (fintech safety): once transactions exist, lock base currency.
    const transactionCount = await prisma.journalEntry.count({ where: { companyId } });

    return {
      companyId: company.id,
      name: company.name,
      baseCurrency: (company as any).baseCurrency ?? null,
      timeZone: (company as any).timeZone ?? null,
      fiscalYearStartMonth: (company as any).fiscalYearStartMonth ?? 1,
      baseCurrencyLocked: transactionCount > 0,
      accountsReceivableAccountId: company.accountsReceivableAccountId,
      accountsReceivableAccount: company.accountsReceivableAccount
        ? {
            id: company.accountsReceivableAccount.id,
            code: company.accountsReceivableAccount.code,
            name: company.accountsReceivableAccount.name,
            type: company.accountsReceivableAccount.type,
          }
        : null,
      accountsPayableAccountId: (company as any).accountsPayableAccountId ?? null,
      accountsPayableAccount: (company as any).accountsPayableAccount
        ? {
            id: (company as any).accountsPayableAccount.id,
            code: (company as any).accountsPayableAccount.code,
            name: (company as any).accountsPayableAccount.name,
            type: (company as any).accountsPayableAccount.type,
          }
        : null,
      inventoryAssetAccountId: (company as any).inventoryAssetAccountId ?? null,
      inventoryAssetAccount: (company as any).inventoryAssetAccount
        ? {
            id: (company as any).inventoryAssetAccount.id,
            code: (company as any).inventoryAssetAccount.code,
            name: (company as any).inventoryAssetAccount.name,
            type: (company as any).inventoryAssetAccount.type,
          }
        : null,
      cogsAccountId: (company as any).cogsAccountId ?? null,
      cogsAccount: (company as any).cogsAccount
        ? {
            id: (company as any).cogsAccount.id,
            code: (company as any).cogsAccount.code,
            name: (company as any).cogsAccount.name,
            type: (company as any).cogsAccount.type,
          }
        : null,
      openingBalanceEquityAccountId: (company as any).openingBalanceEquityAccountId ?? null,
      openingBalanceEquityAccount: (company as any).openingBalanceEquityAccount
        ? {
            id: (company as any).openingBalanceEquityAccount.id,
            code: (company as any).openingBalanceEquityAccount.code,
            name: (company as any).openingBalanceEquityAccount.name,
            type: (company as any).openingBalanceEquityAccount.type,
          }
        : null,
      defaultWarehouseId: (company as any).defaultWarehouseId ?? null,
      defaultWarehouse: (company as any).defaultWarehouse
        ? {
            id: (company as any).defaultWarehouse.id,
            name: (company as any).defaultWarehouse.name,
            isDefault: (company as any).defaultWarehouse.isDefault,
          }
        : null,
    };
  });

  fastify.put('/companies/:companyId/settings', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);

    const body = request.body as {
      baseCurrency?: string | null;
      timeZone?: string | null;
      fiscalYearStartMonth?: number | null;
      accountsReceivableAccountId?: number | null;
      accountsPayableAccountId?: number | null;
      inventoryAssetAccountId?: number | null;
      cogsAccountId?: number | null;
      openingBalanceEquityAccountId?: number | null;
      defaultWarehouseId?: number | null;
    };

    if (
      !('baseCurrency' in body) &&
      !('timeZone' in body) &&
      !('fiscalYearStartMonth' in body) &&
      !('accountsReceivableAccountId' in body) &&
      !('accountsPayableAccountId' in body) &&
      !('inventoryAssetAccountId' in body) &&
      !('cogsAccountId' in body) &&
      !('openingBalanceEquityAccountId' in body) &&
      !('defaultWarehouseId' in body)
    ) {
      reply.status(400);
      return {
        error:
          'at least one setting field is required (baseCurrency, timeZone, fiscalYearStartMonth, accountsReceivableAccountId, accountsPayableAccountId, inventoryAssetAccountId, cogsAccountId, openingBalanceEquityAccountId, defaultWarehouseId)',
      };
    }

    const company = await prisma.company.findUnique({ where: { id: companyId } });
    if (!company) {
      reply.status(404);
      return { error: 'company not found' };
    }

    // --- Validate and enforce company profile fields ---
    if (body.baseCurrency !== undefined) {
      const cur = body.baseCurrency;
      if (cur === null) {
        // allow clearing only if no transactions exist
        const cnt = await prisma.journalEntry.count({ where: { companyId } });
        if (cnt > 0) {
          reply.status(400);
          return { error: 'baseCurrency cannot be cleared after transactions exist' };
        }
      } else {
        const normalized = String(cur).trim().toUpperCase();
        if (!/^[A-Z]{3}$/.test(normalized)) {
          reply.status(400);
          return { error: 'baseCurrency must be a 3-letter currency code (e.g. MMK, USD)' };
        }
        // lock base currency after any journal entries exist
        const cnt = await prisma.journalEntry.count({ where: { companyId } });
        const existing = ((company as any).baseCurrency ?? null) as string | null;
        if (cnt > 0 && existing && existing !== normalized) {
          reply.status(400);
          return { error: 'baseCurrency cannot be changed after transactions exist' };
        }
        // mutate request payload to normalized value (so we store clean)
        (body as any).baseCurrency = normalized;
      }
    }

    if (body.timeZone !== undefined && body.timeZone !== null) {
      const tz = String(body.timeZone).trim();
      if (tz.length < 3 || tz.length > 64) {
        reply.status(400);
        return { error: 'timeZone must be a valid IANA timezone name (e.g. Asia/Yangon)' };
      }
    }

    if (body.fiscalYearStartMonth !== undefined && body.fiscalYearStartMonth !== null) {
      const m = Number(body.fiscalYearStartMonth);
      if (!Number.isInteger(m) || m < 1 || m > 12) {
        reply.status(400);
        return { error: 'fiscalYearStartMonth must be an integer between 1 and 12' };
      }
    }

    if (body.accountsReceivableAccountId !== undefined && body.accountsReceivableAccountId !== null) {
      const arId = body.accountsReceivableAccountId;
      if (!arId || Number.isNaN(Number(arId))) {
        reply.status(400);
        return { error: 'accountsReceivableAccountId must be a valid number or null' };
      }

      const arAccount = await prisma.account.findFirst({
        where: { id: arId, companyId, type: AccountType.ASSET },
      });

      if (!arAccount) {
        reply.status(400);
        return { error: 'accountsReceivableAccountId must be an ASSET account in this company' };
      }
    }

    if (body.accountsPayableAccountId !== undefined && body.accountsPayableAccountId !== null) {
      const apId = body.accountsPayableAccountId;
      if (!apId || Number.isNaN(Number(apId))) {
        reply.status(400);
        return { error: 'accountsPayableAccountId must be a valid number or null' };
      }

      const apAccount = await prisma.account.findFirst({
        where: { id: apId, companyId, type: AccountType.LIABILITY },
      });

      if (!apAccount) {
        reply.status(400);
        return { error: 'accountsPayableAccountId must be a LIABILITY account in this company' };
      }
    }

    if (body.inventoryAssetAccountId !== undefined && body.inventoryAssetAccountId !== null) {
      const invId = body.inventoryAssetAccountId;
      if (!invId || Number.isNaN(Number(invId))) {
        reply.status(400);
        return { error: 'inventoryAssetAccountId must be a valid number or null' };
      }
      const invAcc = await prisma.account.findFirst({
        where: { id: invId, companyId, type: AccountType.ASSET },
      });
      if (!invAcc) {
        reply.status(400);
        return { error: 'inventoryAssetAccountId must be an ASSET account in this company' };
      }
    }

    if (body.cogsAccountId !== undefined && body.cogsAccountId !== null) {
      const cogsId = body.cogsAccountId;
      if (!cogsId || Number.isNaN(Number(cogsId))) {
        reply.status(400);
        return { error: 'cogsAccountId must be a valid number or null' };
      }
      const cogsAcc = await prisma.account.findFirst({
        where: { id: cogsId, companyId, type: AccountType.EXPENSE },
      });
      if (!cogsAcc) {
        reply.status(400);
        return { error: 'cogsAccountId must be an EXPENSE account in this company' };
      }
    }

    if (body.openingBalanceEquityAccountId !== undefined && body.openingBalanceEquityAccountId !== null) {
      const eqId = body.openingBalanceEquityAccountId;
      if (!eqId || Number.isNaN(Number(eqId))) {
        reply.status(400);
        return { error: 'openingBalanceEquityAccountId must be a valid number or null' };
      }
      const eqAcc = await prisma.account.findFirst({
        where: { id: eqId, companyId, type: AccountType.EQUITY },
      });
      if (!eqAcc) {
        reply.status(400);
        return { error: 'openingBalanceEquityAccountId must be an EQUITY account in this company' };
      }
    }

    if (body.defaultWarehouseId !== undefined && body.defaultWarehouseId !== null) {
      const whId = body.defaultWarehouseId;
      if (!whId || Number.isNaN(Number(whId))) {
        reply.status(400);
        return { error: 'defaultWarehouseId must be a valid number or null' };
      }
      const wh = await prisma.warehouse.findFirst({ where: { id: whId, companyId } });
      if (!wh) {
        reply.status(400);
        return { error: 'defaultWarehouseId must be a warehouse in this company' };
      }
    }

    const updated = await prisma.company.update({
      where: { id: companyId },
      data: {
        ...(body.baseCurrency !== undefined ? { baseCurrency: body.baseCurrency as any } : {}),
        ...(body.timeZone !== undefined ? { timeZone: body.timeZone as any } : {}),
        ...(body.fiscalYearStartMonth !== undefined
          ? { fiscalYearStartMonth: body.fiscalYearStartMonth as any }
          : {}),
        ...(body.accountsReceivableAccountId !== undefined
          ? { accountsReceivableAccountId: body.accountsReceivableAccountId }
          : {}),
        ...(body.accountsPayableAccountId !== undefined
          ? { accountsPayableAccountId: body.accountsPayableAccountId }
          : {}),
        ...(body.inventoryAssetAccountId !== undefined
          ? { inventoryAssetAccountId: body.inventoryAssetAccountId }
          : {}),
        ...(body.cogsAccountId !== undefined ? { cogsAccountId: body.cogsAccountId } : {}),
        ...(body.openingBalanceEquityAccountId !== undefined
          ? { openingBalanceEquityAccountId: body.openingBalanceEquityAccountId }
          : {}),
        ...(body.defaultWarehouseId !== undefined ? { defaultWarehouseId: body.defaultWarehouseId } : {}),
      },
      include: {
        accountsReceivableAccount: true,
        accountsPayableAccount: true,
        inventoryAssetAccount: true,
        cogsAccount: true,
        openingBalanceEquityAccount: true,
        defaultWarehouse: true,
      },
    });

    const transactionCount = await prisma.journalEntry.count({ where: { companyId } });

    return {
      companyId: updated.id,
      name: updated.name,
      baseCurrency: (updated as any).baseCurrency ?? null,
      timeZone: (updated as any).timeZone ?? null,
      fiscalYearStartMonth: (updated as any).fiscalYearStartMonth ?? 1,
      baseCurrencyLocked: transactionCount > 0,
      accountsReceivableAccountId: updated.accountsReceivableAccountId,
      accountsReceivableAccount: updated.accountsReceivableAccount
        ? {
            id: updated.accountsReceivableAccount.id,
            code: updated.accountsReceivableAccount.code,
            name: updated.accountsReceivableAccount.name,
            type: updated.accountsReceivableAccount.type,
          }
        : null,
      accountsPayableAccountId: (updated as any).accountsPayableAccountId ?? null,
      accountsPayableAccount: (updated as any).accountsPayableAccount
        ? {
            id: (updated as any).accountsPayableAccount.id,
            code: (updated as any).accountsPayableAccount.code,
            name: (updated as any).accountsPayableAccount.name,
            type: (updated as any).accountsPayableAccount.type,
          }
        : null,
      inventoryAssetAccountId: (updated as any).inventoryAssetAccountId ?? null,
      inventoryAssetAccount: (updated as any).inventoryAssetAccount
        ? {
            id: (updated as any).inventoryAssetAccount.id,
            code: (updated as any).inventoryAssetAccount.code,
            name: (updated as any).inventoryAssetAccount.name,
            type: (updated as any).inventoryAssetAccount.type,
          }
        : null,
      cogsAccountId: (updated as any).cogsAccountId ?? null,
      cogsAccount: (updated as any).cogsAccount
        ? {
            id: (updated as any).cogsAccount.id,
            code: (updated as any).cogsAccount.code,
            name: (updated as any).cogsAccount.name,
            type: (updated as any).cogsAccount.type,
          }
        : null,
      openingBalanceEquityAccountId: (updated as any).openingBalanceEquityAccountId ?? null,
      openingBalanceEquityAccount: (updated as any).openingBalanceEquityAccount
        ? {
            id: (updated as any).openingBalanceEquityAccount.id,
            code: (updated as any).openingBalanceEquityAccount.code,
            name: (updated as any).openingBalanceEquityAccount.name,
            type: (updated as any).openingBalanceEquityAccount.type,
          }
        : null,
      defaultWarehouseId: (updated as any).defaultWarehouseId ?? null,
      defaultWarehouse: (updated as any).defaultWarehouse
        ? {
            id: (updated as any).defaultWarehouse.id,
            name: (updated as any).defaultWarehouse.name,
            isDefault: (updated as any).defaultWarehouse.isDefault,
          }
        : null,
    };
  });

  // --- Account APIs ---
  // List accounts for a company
  fastify.get('/companies/:companyId/accounts', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    const query = request.query as { type?: AccountType };

    const accounts = await prisma.account.findMany({
      where: {
        companyId,
        ...(query.type ? { type: query.type } : {}),
      },
      orderBy: { code: 'asc' },
    });

    return accounts;
  });

  // Create an account (preferred tenant-scoped endpoint)
  fastify.post('/companies/:companyId/accounts', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    const body = request.body as {
      code?: string;
      name?: string;
      type?: AccountType;
      reportGroup?: AccountReportGroup;
      cashflowActivity?: CashflowActivity;
    };

    if (!body.code || !body.name || !body.type) {
      reply.status(400);
      return { error: 'code, name, type are required' };
    }

    const account = await prisma.account.create({
      data: {
        companyId,
        code: body.code,
        name: body.name,
        type: body.type,
        normalBalance: normalBalanceForType(body.type),
        reportGroup: body.reportGroup ?? null,
        cashflowActivity: body.cashflowActivity ?? null,
      },
    });

    return account;
  });

  // Create an account (legacy endpoint; kept for backward compatibility)
  // IMPORTANT: companyId is derived from JWT; client-provided companyId is forbidden.
  fastify.post('/accounts', async (request, reply) => {
    const body = request.body as {
      companyId?: number;
      code?: string;
      name?: string;
      type?: AccountType;
      reportGroup?: AccountReportGroup;
      cashflowActivity?: CashflowActivity;
    };

    const companyId = forbidClientProvidedCompanyId(request, reply, body.companyId);
    if (!body.code || !body.name || !body.type) {
      reply.status(400);
      return { error: 'code, name, type are required' };
    }

    const account = await prisma.account.create({
      data: {
        companyId,
        code: body.code,
        name: body.name,
        type: body.type,
        normalBalance: normalBalanceForType(body.type),
        reportGroup: body.reportGroup ?? null,
        cashflowActivity: body.cashflowActivity ?? null,
      },
    });

    return account;
  });

  // --- Banking accounts (Cash/Bank/E-wallet) ---
  // These are liquidity accounts used for "Deposit To" and for cash/bank movements.
  // They map 1:1 to a Chart of Accounts Account (ASSET).
  fastify.get('/companies/:companyId/banking-accounts', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);

    const rows = await prisma.bankingAccount.findMany({
      where: { companyId },
      include: {
        account: { select: { id: true, code: true, name: true, type: true } },
      },
      orderBy: [{ isPrimary: 'desc' }, { account: { code: 'asc' } }],
    });

    // Backward compatibility: ensure company has a CASH BankingAccount row for default cash account (code 1000).
    const hasCash = rows.some((r) => r.kind === BankingAccountKind.CASH);
    if (!hasCash) {
      const cash = await prisma.account.findFirst({
        where: { companyId, type: AccountType.ASSET, code: '1000' },
        select: { id: true, code: true, name: true, type: true },
      });
      if (cash) {
        try {
          const created = await prisma.bankingAccount.create({
            data: {
              companyId,
              accountId: cash.id,
              kind: BankingAccountKind.CASH,
              description: 'Default cash account',
              isPrimary: rows.length === 0, // only primary if no other banking accounts exist
            },
            include: {
              account: { select: { id: true, code: true, name: true, type: true } },
            },
          });
          rows.unshift(created);
        } catch {
          // Another request might have created it concurrently; ignore.
        }
      }
    }

    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      isPrimary: r.isPrimary,
      bankName: r.bankName,
      accountNumber: r.accountNumber,
      identifierCode: r.identifierCode,
      branch: r.branch,
      description: r.description,
      account: r.account,
    }));
  });

  // Banking account detail: balance + recent transactions for UI
  fastify.get('/companies/:companyId/banking-accounts/:bankingAccountId', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    const bankingAccountId = Number((request.params as any)?.bankingAccountId);
    if (Number.isNaN(bankingAccountId)) {
      reply.status(400);
      return { error: 'invalid bankingAccountId' };
    }

    const banking = await prisma.bankingAccount.findFirst({
      where: { id: bankingAccountId, companyId },
      include: {
        account: { select: { id: true, code: true, name: true, type: true } },
      },
    });
    if (!banking) {
      reply.status(404);
      return { error: 'banking account not found' };
    }

    const sums = await prisma.journalLine.aggregate({
      where: { companyId, accountId: banking.accountId },
      _sum: { debit: true, credit: true },
    });
    const totalDebit = Number(sums._sum.debit ?? 0);
    const totalCredit = Number(sums._sum.credit ?? 0);

    // For ASSET accounts: balance = debit - credit.
    // (We only allow ASSET accounts for BankingAccount today.)
    const balance = totalDebit - totalCredit;

    const lines = await prisma.journalLine.findMany({
      where: { companyId, accountId: banking.accountId },
      orderBy: [
        { journalEntry: { date: 'desc' } },
        { journalEntryId: 'desc' },
        { id: 'desc' },
      ],
      take: 50,
      include: {
        journalEntry: {
          include: {
            invoice: true,
            payment: { include: { invoice: true } },
          },
        },
      },
    });

    const transactions = lines.map((l) => {
      const je: any = l.journalEntry;
      const type =
        je?.payment ? 'Invoice Payment' : je?.invoice ? 'Invoice Posted' : 'Journal Entry';
      const details =
        je?.payment?.invoice?.invoiceNumber
          ? `Payment for ${je.payment.invoice.invoiceNumber}`
          : je?.invoice?.invoiceNumber
            ? `Invoice ${je.invoice.invoiceNumber}`
            : je?.description ?? '';

      return {
        date: je?.date ?? null,
        type,
        details,
        journalEntryId: l.journalEntryId,
        debit: l.debit.toString(),
        credit: l.credit.toString(),
      };
    });

    return {
      id: banking.id,
      kind: banking.kind,
      isPrimary: banking.isPrimary,
      bankName: banking.bankName,
      accountNumber: banking.accountNumber,
      identifierCode: banking.identifierCode,
      branch: banking.branch,
      description: banking.description,
      account: banking.account,
      balance,
      transactions,
    };
  });

  fastify.post('/companies/:companyId/banking-accounts', async (request, reply) => {
    const companyId = requireCompanyIdParam(request, reply);
    const body = request.body as {
      kind?: BankingAccountKind;
      accountCode?: string;
      accountName?: string;
      bankName?: string;
      accountNumber?: string;
      identifierCode?: string;
      branch?: string;
      description?: string;
      isPrimary?: boolean;
    };

    if (!body.kind || !body.accountCode || !body.accountName) {
      reply.status(400);
      return { error: 'kind, accountCode, accountName are required' };
    }

    const kind = body.kind as BankingAccountKind;
    if (!Object.values(BankingAccountKind).includes(kind)) {
      reply.status(400);
      return { error: 'invalid kind' };
    }

    // Bank/Cash/E-wallet should be ASSET accounts.
    const created = await prisma.$transaction(async (tx) => {
      const account = await tx.account.create({
        data: {
          companyId,
          code: body.accountCode!,
          name: body.accountName!,
          type: AccountType.ASSET,
          normalBalance: NormalBalance.DEBIT,
          reportGroup: AccountReportGroup.CASH_AND_CASH_EQUIVALENTS,
          cashflowActivity: CashflowActivity.OPERATING,
        },
      });

      // If primary, unset other primaries
      if (body.isPrimary) {
        await tx.bankingAccount.updateMany({
          where: { companyId, isPrimary: true },
          data: { isPrimary: false },
        });
      }

      const banking = await tx.bankingAccount.create({
        data: {
          companyId,
          accountId: account.id,
          kind,
          bankName: body.bankName ?? null,
          accountNumber: body.accountNumber ?? null,
          identifierCode: body.identifierCode ?? null,
          branch: body.branch ?? null,
          description: body.description ?? null,
          isPrimary: body.isPrimary ?? false,
        },
        include: {
          account: true,
        },
      });

      return banking;
    });

    return {
      id: created.id,
      kind: created.kind,
      isPrimary: created.isPrimary,
      bankName: created.bankName,
      accountNumber: created.accountNumber,
      identifierCode: created.identifierCode,
      branch: created.branch,
      description: created.description,
      account: {
        id: created.account.id,
        code: created.account.code,
        name: created.account.name,
        type: created.account.type,
      },
    };
  });

  function normalBalanceForType(type: AccountType): NormalBalance {
    switch (type) {
      case AccountType.ASSET:
      case AccountType.EXPENSE:
        return NormalBalance.DEBIT;
      case AccountType.LIABILITY:
      case AccountType.EQUITY:
      case AccountType.INCOME:
        return NormalBalance.CREDIT;
      default:
        return NormalBalance.DEBIT;
    }
  }
}

