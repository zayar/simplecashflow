-- Perf indexes for slow invoice post/payment flows (Cloud Run + Cloud SQL).
-- Focus:
-- - StockMove correlationId linking (avoids table scans)
-- - StockMove per-item timeline queries (WAC replay / lastMove checks)
-- - Payment aggregates by invoice + reversedAt (avoid scans)

-- StockMove: speed up WAC + lastMove lookups and deterministic ordering
CREATE INDEX StockMove_co_loc_item_date_id ON StockMove(companyId, warehouseId, itemId, date, id);

-- StockMove: speed up linking moves created during a single posting transaction
CREATE INDEX StockMove_co_corr_idx ON StockMove(companyId, correlationId);

-- StockMove: speed up void/reversal lookups by reference
CREATE INDEX StockMove_co_ref_idx ON StockMove(companyId, referenceType, referenceId);

-- Payment: speed up SUM(amount) where invoiceId + reversedAt filters
CREATE INDEX Payment_co_invoice_rev_idx ON Payment(companyId, invoiceId, reversedAt);

