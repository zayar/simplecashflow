-- Add VALUE_ADJUSTMENT stock move type to support landed cost capitalization (value-only)

ALTER TABLE `StockMove`
  MODIFY `type` ENUM(
    'OPENING',
    'ADJUSTMENT',
    'SALE_ISSUE',
    'SALE_RETURN',
    'PURCHASE_RECEIPT',
    'PURCHASE_RETURN',
    'TRANSFER_OUT',
    'TRANSFER_IN',
    'VALUE_ADJUSTMENT'
  ) NOT NULL;

