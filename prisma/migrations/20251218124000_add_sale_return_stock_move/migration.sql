-- Add SALE_RETURN to StockMove.type enum
ALTER TABLE `StockMove`
  MODIFY `type` ENUM(
    'OPENING',
    'ADJUSTMENT',
    'SALE_ISSUE',
    'SALE_RETURN',
    'PURCHASE_RECEIPT',
    'TRANSFER_OUT',
    'TRANSFER_IN'
  ) NOT NULL;


