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