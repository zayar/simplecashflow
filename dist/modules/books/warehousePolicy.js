/**
 * Location selection policy for inventory movements created from documents.
 *
 * Important: when a document explicitly sets a location (e.g., invoice.locationId),
 * stock movements must use that location so inventory reports match the document.
 *
 * Fallback order:
 * - invoiceLocationId (explicit on document)
 * - itemDefaultLocationId (item-level default)
 * - companyDefaultLocationId (company-level default / "Main")
 */
export function resolveLocationForStockIssue(args) {
    const norm = (v) => {
        const n = typeof v === 'number' ? v : v === null || v === undefined ? NaN : Number(v);
        return Number.isInteger(n) && n > 0 ? n : null;
    };
    return (norm(args.invoiceLocationId) ??
        norm(args.itemDefaultLocationId) ??
        norm(args.companyDefaultLocationId) ??
        null);
}
//# sourceMappingURL=warehousePolicy.js.map