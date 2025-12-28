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
export declare function resolveLocationForStockIssue(args: {
    invoiceLocationId: number | null | undefined;
    itemDefaultLocationId: number | null | undefined;
    companyDefaultLocationId: number | null | undefined;
}): number | null;
//# sourceMappingURL=warehousePolicy.d.ts.map