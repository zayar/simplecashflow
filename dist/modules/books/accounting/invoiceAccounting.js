import { Decimal } from '@prisma/client/runtime/library';
function d2(n) {
    return n.toDecimalPlaces(2);
}
function d4(n) {
    return n.toDecimalPlaces(4);
}
function toDecimal(v) {
    if (v === null || v === undefined)
        return new Decimal(0);
    return v instanceof Decimal ? v : new Decimal(v);
}
export function computeInvoiceTotalsAndIncomeBuckets(lines) {
    let subtotal = new Decimal(0);
    let taxAmount = new Decimal(0);
    const incomeBuckets = new Map();
    for (const line of lines) {
        const qty = d2(toDecimal(line.quantity));
        const unit = d2(toDecimal(line.unitPrice));
        const lineSubtotal = d2(qty.mul(unit));
        const discount = d2(toDecimal(line.discountAmount ?? 0));
        if (discount.lessThan(0) || discount.greaterThan(lineSubtotal)) {
            throw new Error('invoice line discountAmount must be between 0 and line subtotal');
        }
        const netSubtotal = d2(lineSubtotal.sub(discount));
        subtotal = d2(subtotal.add(netSubtotal));
        const rate = d4(toDecimal(line.taxRate ?? 0));
        if (rate.lessThan(0) || rate.greaterThan(1)) {
            throw new Error('invoice line taxRate must be between 0 and 1');
        }
        const lineTax = d2(netSubtotal.mul(rate));
        taxAmount = d2(taxAmount.add(lineTax));
        const prev = incomeBuckets.get(line.incomeAccountId) ?? new Decimal(0);
        incomeBuckets.set(line.incomeAccountId, d2(prev.add(netSubtotal)));
    }
    const total = d2(subtotal.add(taxAmount));
    return { subtotal: d2(subtotal), taxAmount: d2(taxAmount), total, incomeBuckets };
}
export function assertTotalsMatchStored(total, storedTotal) {
    const t = d2(total);
    const s = d2(storedTotal);
    if (!t.equals(s)) {
        throw new Error(`rounding mismatch: recomputed total ${t.toString()} != stored total ${s.toString()}`);
    }
}
export function buildInvoicePostingJournalLines(args) {
    const taxAmount = args.taxAmount ? d2(toDecimal(args.taxAmount)) : new Decimal(0);
    const total = d2(toDecimal(args.total));
    const lines = [
        { accountId: args.arAccountId, debit: total, credit: new Decimal(0) },
        ...Array.from(args.incomeBuckets.entries()).map(([incomeAccountId, amt]) => ({
            accountId: incomeAccountId,
            debit: new Decimal(0),
            credit: d2(amt),
        })),
    ];
    if (taxAmount.greaterThan(0)) {
        if (!args.taxPayableAccountId)
            throw new Error('taxPayableAccountId required when taxAmount > 0');
        lines.push({ accountId: args.taxPayableAccountId, debit: new Decimal(0), credit: taxAmount });
    }
    const totalCogs = args.totalCogs ? d2(toDecimal(args.totalCogs)) : new Decimal(0);
    if (totalCogs.greaterThan(0)) {
        if (!args.cogsAccountId || !args.inventoryAssetAccountId) {
            throw new Error('cogsAccountId and inventoryAssetAccountId required when totalCogs > 0');
        }
        lines.push({ accountId: args.cogsAccountId, debit: totalCogs, credit: new Decimal(0) }, { accountId: args.inventoryAssetAccountId, debit: new Decimal(0), credit: totalCogs });
    }
    return lines;
}
export function sumDebitsCredits(lines) {
    const debit = d2(lines.reduce((s, l) => s.add(l.debit), new Decimal(0)));
    const credit = d2(lines.reduce((s, l) => s.add(l.credit), new Decimal(0)));
    return { debit, credit };
}
//# sourceMappingURL=invoiceAccounting.js.map