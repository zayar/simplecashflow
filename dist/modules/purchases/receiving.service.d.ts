import { Prisma } from '@prisma/client';
export type PoLine = {
    id: number;
    itemId: number;
    quantity: Prisma.Decimal;
};
export type ReceiptLine = {
    purchaseOrderLineId: number | null;
    quantity: Prisma.Decimal;
};
/**
 * Computes remaining qty per PO line based on linked receipt lines.
 * Only receipt lines that reference a PO line are counted.
 */
export declare function computeRemainingByPoLine(args: {
    poLines: PoLine[];
    receiptLines: ReceiptLine[];
}): Map<number, Prisma.Decimal>;
//# sourceMappingURL=receiving.service.d.ts.map