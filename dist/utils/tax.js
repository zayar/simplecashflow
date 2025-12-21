import { Prisma } from '@prisma/client';
/**
 * Calculate tax for a single line item.
 * @param subtotal - Line subtotal before tax (qty * unitPrice)
 * @param taxRate - Tax rate as decimal (e.g., 0.10 for 10%)
 * @returns Tax amount rounded to 2 decimal places
 */
export function calculateLineTax(subtotal, taxRate) {
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
export function calculateTaxAggregate(lines) {
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
export async function validateTaxConfiguration(tx, companyId) {
    const company = await tx.company.findUnique({
        where: { id: companyId },
        select: { taxPayableAccountId: true },
    });
    if (!company) {
        throw Object.assign(new Error('company not found'), { statusCode: 404 });
    }
    // For now, we'll look for a Tax Payable account by code
    // In a full implementation, this would be a company setting
    let taxPayableAccountId = company.taxPayableAccountId;
    if (!taxPayableAccountId) {
        // Try to find Tax Payable account by code (2100)
        const taxAccount = await tx.account.findFirst({
            where: { companyId, type: 'LIABILITY', code: '2100' },
            select: { id: true },
        });
        taxPayableAccountId = taxAccount?.id;
    }
    if (!taxPayableAccountId) {
        throw Object.assign(new Error('company.taxPayableAccountId is not set. Please create a Tax Payable account (LIABILITY, code 2100) or set it in company settings.'), { statusCode: 400 });
    }
    // Validate it's a LIABILITY account
    const taxAccount = await tx.account.findFirst({
        where: { id: taxPayableAccountId, companyId, type: 'LIABILITY' },
    });
    if (!taxAccount) {
        throw Object.assign(new Error('taxPayableAccountId must be a LIABILITY account in this company'), { statusCode: 400 });
    }
    return { taxPayableAccountId };
}
/**
 * Format tax rate for display (e.g., 0.10 -> "10%")
 */
export function formatTaxRate(taxRate) {
    const rate = new Prisma.Decimal(taxRate);
    return `${rate.mul(100).toFixed(2)}%`;
}
/**
 * Parse tax rate from percentage string or decimal
 * @param input - "10" or "10%" or 0.10
 * @returns Decimal tax rate (e.g., 0.10)
 */
export function parseTaxRate(input) {
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
//# sourceMappingURL=tax.js.map