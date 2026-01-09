import { Prisma } from '@prisma/client';
/**
 * CRITICAL FIX #5: Tax Handling System
 *
 * Tax calculation utilities for invoices, bills, and other taxable documents.
 * Ensures tax compliance and correct revenue/expense recognition.
 */
export type TaxLineInput = {
    lineSubtotal: Prisma.Decimal;
    taxRate: Prisma.Decimal;
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
export declare function pickFirstUnusedNumericCode(usedCodes: Set<string>, start: number, end: number): string;
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
export declare function ensureTaxPayableAccount(tx: any, companyId: number): Promise<number>;
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
export declare function ensureTaxReceivableAccount(tx: any, companyId: number): Promise<number>;
export declare function ensureTaxReceivableAccountIfNeeded(tx: any, companyId: number, taxAmount: Prisma.Decimal | number | string | null | undefined): Promise<number | null>;
export declare function ensureTaxPayableAccountIfNeeded(tx: any, companyId: number, taxAmount: Prisma.Decimal | number | string | null | undefined): Promise<number | null>;
/**
 * Calculate tax for a single line item.
 * @param subtotal - Line subtotal before tax (qty * unitPrice)
 * @param taxRate - Tax rate as decimal (e.g., 0.10 for 10%)
 * @returns Tax amount rounded to 2 decimal places
 */
export declare function calculateLineTax(subtotal: Prisma.Decimal, taxRate: Prisma.Decimal): Prisma.Decimal;
/**
 * Calculate aggregate tax for multiple lines.
 * Uses line-level rounding (sum of rounded line taxes).
 *
 * @param lines - Array of line inputs with subtotal and tax rate
 * @returns Aggregate calculation result
 */
export declare function calculateTaxAggregate(lines: TaxLineInput[]): TaxCalculationResult;
/**
 * Validate tax configuration for a company.
 * Ensures the company has a valid Tax Payable account (LIABILITY).
 */
export declare function validateTaxConfiguration(tx: any, companyId: number): Promise<{
    taxPayableAccountId: number;
}>;
/**
 * Format tax rate for display (e.g., 0.10 -> "10%")
 */
export declare function formatTaxRate(taxRate: Prisma.Decimal | number): string;
/**
 * Parse tax rate from percentage string or decimal
 * @param input - "10" or "10%" or 0.10
 * @returns Decimal tax rate (e.g., 0.10)
 */
export declare function parseTaxRate(input: string | number): Prisma.Decimal;
//# sourceMappingURL=tax.d.ts.map