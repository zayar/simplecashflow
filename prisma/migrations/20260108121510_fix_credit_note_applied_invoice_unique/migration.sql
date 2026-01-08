-- Fix: appliedInvoiceId must NOT be unique.
-- One credit note can be applied to at most one invoice (single FK field),
-- but one invoice can have multiple credit notes applied.
--
-- MySQL note: a foreign key requires an index; if the FK is currently using the UNIQUE index,
-- we must drop the FK first, drop the UNIQUE index, then re-add the FK using a non-unique index.

-- 1) Drop FK on appliedInvoiceId if present (dynamic name-safe)
SET @fk := (
  SELECT kcu.CONSTRAINT_NAME
  FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
  WHERE kcu.TABLE_SCHEMA = DATABASE()
    AND kcu.TABLE_NAME = 'CreditNote'
    AND kcu.COLUMN_NAME = 'appliedInvoiceId'
    AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
  LIMIT 1
);

SET @sql := IF(@fk IS NOT NULL AND @fk <> '',
  CONCAT('ALTER TABLE `CreditNote` DROP FOREIGN KEY `', @fk, '`'),
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2) Drop accidental UNIQUE index if it exists
SET @idx := (
  SELECT COUNT(1)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'CreditNote'
    AND INDEX_NAME = 'CreditNote_appliedInvoiceId_key'
);

SET @sql := IF(@idx > 0,
  'DROP INDEX `CreditNote_appliedInvoiceId_key` ON `CreditNote`',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 3) Ensure a NON-UNIQUE index exists for the FK (use appliedInvoiceId alone)
SET @idx2 := (
  SELECT COUNT(1)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'CreditNote'
    AND INDEX_NAME = 'CreditNote_appliedInvoiceId_idx'
);

SET @sql := IF(@idx2 > 0,
  'SELECT 1',
  'CREATE INDEX `CreditNote_appliedInvoiceId_idx` ON `CreditNote`(`appliedInvoiceId`)'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 4) Re-add FK with stable name if missing
SET @fk2 := (
  SELECT COUNT(1)
  FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
  WHERE rc.CONSTRAINT_SCHEMA = DATABASE()
    AND rc.TABLE_NAME = 'CreditNote'
    AND rc.CONSTRAINT_NAME = 'CreditNote_appliedInvoiceId_fkey'
);

SET @sql := IF(@fk2 > 0,
  'SELECT 1',
  'ALTER TABLE `CreditNote` ADD CONSTRAINT `CreditNote_appliedInvoiceId_fkey` FOREIGN KEY (`appliedInvoiceId`) REFERENCES `Invoice`(`id`) ON DELETE SET NULL ON UPDATE CASCADE'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

