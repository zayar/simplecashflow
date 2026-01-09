import { Prisma } from '@prisma/client';

/**
 * CRITICAL FIX #5: Tax Handling System
 * 
 * Tax calculation utilities for invoices, bills, and other taxable documents.
 * Ensures tax compliance and correct revenue/expense recognition.
 */

export type TaxLineInput = {
  lineSubtotal: Prisma.Decimal;
  taxRate: Prisma.Decimal; // e.g., 0.10 for 10%
};

export type TaxCalculationResult = {
  subtotal: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  total: Prisma.Decimal;
};

/**
 * Pick the first unused numeric account code within [start, end].
 * (Pure helper so we can unit-test code selection without a DB.)
 */
export function pickFirstUnusedNumericCode(usedCodes: Set<string>, start: number, end: number): string {
  for (let i = start; i <= end; i++) {
    const code = String(i);
    if (!usedCodes.has(code)) return code;
  }
  throw new Error(`no available account code in range ${start}..${end}`);
}

/**
 * Ensures the company has a dedicated Tax Payable account (LIABILITY) and returns its id.
 *
 * Important: Do NOT assume a fixed code like 2100. Some tenants may already use 2100 for
 * other liabilities (e.g. Customer Advance), which would cause tax to post to the wrong account.
 *
 * Strategy:
 * - Prefer an existing LIABILITY account named "Tax Payable"
 * - Otherwise create one, using code 2100 if free; else pick the next free numeric code in 2101..2999
 */
export async function ensureTaxPayableAccount(tx: any, companyId: number): Promise<number> {
  if (!companyId || Number.isNaN(Number(companyId))) {
    throw Object.assign(new Error('companyId is required'), { statusCode: 400 });
  }

  // Prefer existing account by name (works even if code differs per tenant).
  const byName = await tx.account.findFirst({
    where: { companyId, type: 'LIABILITY', name: 'Tax Payable' },
    select: { id: true },
  });
  if (byName?.id) return byName.id;

  // If no "Tax Payable" exists, create one with a safe (non-conflicting) code.
  const liabilityCodes = await tx.account.findMany({
    where: { companyId, type: 'LIABILITY' },
    select: { code: true },
  });
  const used = new Set<string>(liabilityCodes.map((a: any) => String(a.code ?? '').trim()).filter(Boolean));

  const desired = !used.has('2100') ? '2100' : pickFirstUnusedNumericCode(used, 2101, 2999);

  const created = await tx.account.create({
    data: {
      companyId,
      code: desired,
      name: 'Tax Payable',
      type: 'LIABILITY',
      normalBalance: 'CREDIT',
      reportGroup: 'OTHER_CURRENT_LIABILITY',
      cashflowActivity: 'OPERATING',
    },
    select: { id: true },
  });
  return created.id;
}

/**
 * Ensures the company has a dedicated Tax Receivable account (ASSET) and returns its id.
 *
 * Used for purchase-side taxes (input tax / recoverable VAT). This keeps purchase taxes
 * off P&L and tracks them as an asset until settled/claimed.
 *
 * Strategy:
 * - Prefer an existing ASSET account named "Tax Receivable"
 * - Otherwise create one, using code 1210 if free; else pick the next free numeric code in 1211..1999
 */
export async function ensureTaxReceivableAccount(tx: any, companyId: number): Promise<number> {
  if (!companyId || Number.isNaN(Number(companyId))) {
    throw Object.assign(new Error('companyId is required'), { statusCode: 400 });
  }

  const byName = await tx.account.findFirst({
    where: { companyId, type: 'ASSET', name: 'Tax Receivable' },
    select: { id: true },
  });
  if (byName?.id) return byName.id;

  const assetCodes = await tx.account.findMany({
    where: { companyId, type: 'ASSET' },
    select: { code: true },
  });
  const used = new Set<string>(assetCodes.map((a: any) => String(a.code ?? '').trim()).filter(Boolean));

  const desired = !used.has('1210') ? '1210' : pickFirstUnusedNumericCode(used, 1211, 1999);

  const created = await tx.account.create({
    data: {
      companyId,
      code: desired,
      name: 'Tax Receivable',
      type: 'ASSET',
      normalBalance: 'DEBIT',
      reportGroup: 'OTHER_CURRENT_ASSET',
      cashflowActivity: 'OPERATING',
    },
    select: { id: true },
  });
  return created.id;
}

export async function ensureTaxReceivableAccountIfNeeded(
  tx: any,
  companyId: number,
  taxAmount: Prisma.Decimal | number | string | null | undefined
): Promise<number | null> {
  const amt = taxAmount instanceof Prisma.Decimal ? taxAmount : new Prisma.Decimal(taxAmount ?? 0);
  if (!amt.greaterThan(0)) return null;
  return await ensureTaxReceivableAccount(tx, companyId);
}

export async function ensureTaxPayableAccountIfNeeded(
  tx: any,
  companyId: number,
  taxAmount: Prisma.Decimal | number | string | null | undefined
): Promise<number | null> {
  const amt = taxAmount instanceof Prisma.Decimal ? taxAmount : new Prisma.Decimal(taxAmount ?? 0);
  if (!amt.greaterThan(0)) return null;
  return await ensureTaxPayableAccount(tx, companyId);
}

/**
 * Calculate tax for a single line item.
 * @param subtotal - Line subtotal before tax (qty * unitPrice)
 * @param taxRate - Tax rate as decimal (e.g., 0.10 for 10%)
 * @returns Tax amount rounded to 2 decimal places
 */
export function calculateLineTax(
  subtotal: Prisma.Decimal,
  taxRate: Prisma.Decimal
): Prisma.Decimal {
  if (taxRate.lessThan(0)) {
    throw new Error('tax rate cannot be negative');
  }
  if (taxRate.greaterThan(1)) {
    throw new Error('tax rate must be <= 1.0 (use 0.10 for 10%, not 10)');
  }
  return subtotal.mul(taxRate).toDecimalPlaces(2);
}

/**
 * Calculate aggregate tax for multiple lines.
 * Uses line-level rounding (sum of rounded line taxes).
 * 
 * @param lines - Array of line inputs with subtotal and tax rate
 * @returns Aggregate calculation result
 */
export function calculateTaxAggregate(
  lines: TaxLineInput[]
): TaxCalculationResult {
  let subtotal = new Prisma.Decimal(0);
  let taxAmount = new Prisma.Decimal(0);

  for (const line of lines) {
    const lineSubtotal = new Prisma.Decimal(line.lineSubtotal).toDecimalPlaces(2);
    const lineTaxRate = new Prisma.Decimal(line.taxRate).toDecimalPlaces(4);
    const lineTax = calculateLineTax(lineSubtotal, lineTaxRate);

    subtotal = subtotal.add(lineSubtotal);
    taxAmount = taxAmount.add(lineTax);
  }

  subtotal = subtotal.toDecimalPlaces(2);
  taxAmount = taxAmount.toDecimalPlaces(2);
  const total = subtotal.add(taxAmount).toDecimalPlaces(2);

  return { subtotal, taxAmount, total };
}

/**
 * Validate tax configuration for a company.
 * Ensures the company has a valid Tax Payable account (LIABILITY).
 */
export async function validateTaxConfiguration(
  tx: any,
  companyId: number
): Promise<{ taxPayableAccountId: number }> {
  const taxPayableAccountId = await ensureTaxPayableAccount(tx, companyId);
  return { taxPayableAccountId };
}

/**
 * Format tax rate for display (e.g., 0.10 -> "10%")
 */
export function formatTaxRate(taxRate: Prisma.Decimal | number): string {
  const rate = new Prisma.Decimal(taxRate);
  return `${rate.mul(100).toFixed(2)}%`;
}

/**
 * Parse tax rate from percentage string or decimal
 * @param input - "10" or "10%" or 0.10
 * @returns Decimal tax rate (e.g., 0.10)
 */
export function parseTaxRate(input: string | number): Prisma.Decimal {
  if (typeof input === 'number') {
    return new Prisma.Decimal(input).toDecimalPlaces(4);
  }

  const str = String(input).trim();
  if (str.endsWith('%')) {
    const pct = parseFloat(str.slice(0, -1));
    if (isNaN(pct)) {
      throw new Error(`invalid tax rate: ${input}`);
    }
    return new Prisma.Decimal(pct).div(100).toDecimalPlaces(4);
  }

  const decimal = parseFloat(str);
  if (isNaN(decimal)) {
    throw new Error(`invalid tax rate: ${input}`);
  }

  // Auto-detect: if > 1, assume percentage (e.g., 10 means 10%)
  if (decimal > 1) {
    return new Prisma.Decimal(decimal).div(100).toDecimalPlaces(4);
  }

  return new Prisma.Decimal(decimal).toDecimalPlaces(4);
}

