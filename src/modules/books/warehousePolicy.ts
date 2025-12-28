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
export function resolveLocationForStockIssue(args: {
  invoiceLocationId: number | null | undefined;
  itemDefaultLocationId: number | null | undefined;
  companyDefaultLocationId: number | null | undefined;
}): number | null {
  const norm = (v: unknown): number | null => {
    const n = typeof v === 'number' ? v : v === null || v === undefined ? NaN : Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
  };

  return (
    norm(args.invoiceLocationId) ??
    norm(args.itemDefaultLocationId) ??
    norm(args.companyDefaultLocationId) ??
    null
  );
}


