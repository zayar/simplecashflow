/**
 * Ensure the company has exactly one "Vendor Advance" asset account.
 *
 * This also consolidates legacy accounts:
 * - "Supplier Advance"
 * - "Vendor Prepayments"
 *
 * into the canonical "Vendor Advance" account by:
 * - updating AccountBalance (so Balance Sheet shows one line)
 * - updating VendorAdvance.prepaymentAccountId
 *
 * Note: We do NOT rewrite JournalLine, because ledger lines are immutable.
 *
 * Safe to run multiple times.
 */
export declare function ensureVendorAdvanceAccount(tx: any, companyId: number): Promise<number>;
//# sourceMappingURL=vendorAdvanceAccount.d.ts.map