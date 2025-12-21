import { PrismaClient } from '@prisma/client';
import { getTenantCompanyId } from './tenantContext.js';

const base = new PrismaClient();

// Fintech safety rail: posted ledger data must be immutable.
// If you need to "change" a posted entry, create an adjustment/reversal entry instead.
base.$use(async (params, next) => {
  if (params.model === 'JournalEntry' || params.model === 'JournalLine') {
    const action = params.action;
    if (
      action === 'update' ||
      action === 'updateMany' ||
      action === 'delete' ||
      action === 'deleteMany' ||
      action === 'upsert'
    ) {
      throw Object.assign(new Error(`immutable ledger: ${params.model}.${action} is not allowed`), {
        statusCode: 400,
      });
    }
  }
  return next(params);
});

// Tenant isolation (defense-in-depth): in request context (ALS), automatically inject companyId
// into queries for tenant-scoped models. For operations that cannot safely accept extra filters
// (findUnique/update/delete/upsert), we fail closed unless the query already includes companyId.
//
// This prevents "oops forgot companyId" mistakes from turning into cross-tenant data leaks.
const TENANT_MODELS = new Set<string>([
  'Account',
  'AccountBalance',
  'AuditLog',
  'BankingAccount',
  'CreditNote',
  'CreditNoteLine',
  'Customer',
  'DailySummary',
  'DocumentSequence',
  'Event',
  'Expense',
  'ExpensePayment',
  'IdempotentRequest',
  'Invoice',
  'InvoiceLine',
  'Item',
  'JournalEntry',
  'JournalLine',
  'Payment',
  'PeriodClose',
  'ProcessedEvent',
  'PurchaseBill',
  'PurchaseBillLine',
  'PurchaseBillPayment',
  'StockBalance',
  'StockMove',
  'TaxGroup',
  'TaxGroupMember',
  'TaxRate',
  'User', // tenant-scoped users (email is global-unique, but data access must still be scoped)
  'Vendor',
  'Warehouse',
]);

function whereHasCompanyId(where: any): boolean {
  if (!where || typeof where !== 'object') return false;
  if (Object.prototype.hasOwnProperty.call(where, 'companyId')) return true;
  // Support composite unique selectors like:
  // - where: { companyId_key: { companyId, key } }
  // - where: { companyId_accountId_date: { companyId, accountId, date } }
  for (const v of Object.values(where)) {
    if (v && typeof v === 'object' && whereHasCompanyId(v)) return true;
  }
  return false;
}

function collectWhereCompanyIds(where: any, out: number[] = []): number[] {
  if (!where || typeof where !== 'object') return out;
  if (Object.prototype.hasOwnProperty.call(where, 'companyId')) {
    const n = Number((where as any).companyId);
    if (Number.isFinite(n)) out.push(n);
  }
  for (const v of Object.values(where)) {
    if (v && typeof v === 'object') collectWhereCompanyIds(v, out);
  }
  return out;
}

function assertWhereTenant(where: any, tenantCompanyId: number) {
  const ids = collectWhereCompanyIds(where);
  if (ids.length === 0) {
    throw new Error('tenant isolation: missing where.companyId');
  }
  for (const id of ids) {
    if (Number(id) !== tenantCompanyId) {
      throw new Error('tenant isolation: where.companyId does not match request tenant');
    }
  }
}

function injectWhereCompanyId(args: any, companyId: number): any {
  const nextArgs = { ...(args ?? {}) };
  nextArgs.where = { ...(nextArgs.where ?? {}), companyId };
  return nextArgs;
}

function injectCreateCompanyId(args: any, companyId: number): any {
  const nextArgs = { ...(args ?? {}) };
  if (!nextArgs.data) return nextArgs;
  if (Array.isArray(nextArgs.data)) {
    nextArgs.data = nextArgs.data.map((d: any) => {
      if (!d || typeof d !== 'object') return d;
      if (d.companyId !== undefined && d.companyId !== companyId) {
        throw new Error('tenant mismatch: create data.companyId does not match request tenant');
      }
      return { ...d, companyId };
    });
    return nextArgs;
  }
  if (nextArgs.data.companyId !== undefined && nextArgs.data.companyId !== companyId) {
    throw new Error('tenant mismatch: create data.companyId does not match request tenant');
  }
  nextArgs.data = { ...nextArgs.data, companyId };
  return nextArgs;
}

export const prisma = base.$extends({
  name: 'tenantIsolation',
  query: {
    $allModels: {
      $allOperations({ model, operation, args, query }: any) {
        const tenantCompanyId = getTenantCompanyId();
        if (!tenantCompanyId) {
          // No request tenant context (e.g., worker/publisher/CLI). Do not inject or enforce.
          return (query as any)(args);
        }
        if (!TENANT_MODELS.has(model)) {
          return (query as any)(args);
        }

        // Safe injections (where supports additional AND filters)
        if (
          operation === 'findMany' ||
          operation === 'findFirst' ||
          operation === 'findFirstOrThrow' ||
          operation === 'count' ||
          operation === 'aggregate' ||
          operation === 'groupBy' ||
          operation === 'updateMany' ||
          operation === 'deleteMany'
        ) {
          return (query as any)(injectWhereCompanyId(args, tenantCompanyId));
        }

        if (operation === 'create' || operation === 'createMany') {
          return (query as any)(injectCreateCompanyId(args, tenantCompanyId));
        }

        // Fail closed for operations where Prisma requires a unique selector and cannot safely accept extra filters.
        if (
          operation === 'findUnique' ||
          operation === 'findUniqueOrThrow' ||
          operation === 'update' ||
          operation === 'delete' ||
          operation === 'upsert'
        ) {
          if (!whereHasCompanyId((args as any)?.where)) {
            throw new Error(
              `tenant isolation: ${model}.${operation} requires where.companyId in request context. Use findFirst/updateMany/deleteMany with where: { id, companyId } (or a composite unique that includes companyId).`
            );
          }
          assertWhereTenant((args as any).where, tenantCompanyId);
          return (query as any)(args);
        }

        return (query as any)(args);
      },
    },
  },
});

