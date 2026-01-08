import { Prisma } from '@prisma/client';
/**
 * Computes remaining qty per PO line based on linked receipt lines.
 * Only receipt lines that reference a PO line are counted.
 */
export function computeRemainingByPoLine(args) {
    const remaining = new Map();
    for (const l of args.poLines ?? []) {
        remaining.set(l.id, new Prisma.Decimal(l.quantity).toDecimalPlaces(2));
    }
    for (const rl of args.receiptLines ?? []) {
        const poLineId = rl.purchaseOrderLineId;
        if (!poLineId)
            continue;
        const prev = remaining.get(poLineId);
        if (!prev)
            continue;
        remaining.set(poLineId, prev.sub(new Prisma.Decimal(rl.quantity).toDecimalPlaces(2)).toDecimalPlaces(2));
    }
    // Clamp tiny negatives due to rounding
    for (const [id, qty] of remaining.entries()) {
        if (qty.lessThan(0) && qty.abs().lessThanOrEqualTo(new Prisma.Decimal('0.01'))) {
            remaining.set(id, new Prisma.Decimal(0));
        }
    }
    return remaining;
}
//# sourceMappingURL=receiving.service.js.map