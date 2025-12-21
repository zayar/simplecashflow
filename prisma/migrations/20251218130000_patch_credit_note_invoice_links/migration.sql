-- Patch migration (safe/idempotent):
-- Some environments may have applied the original credit note migration before invoice linkage fields existed.
-- This migration conditionally adds:
-- - CreditNote.invoiceId (FK -> Invoice, ON DELETE SET NULL)
-- - CreditNoteLine.invoiceLineId (FK -> InvoiceLine, ON DELETE SET NULL)
-- - supporting indexes

-- ---- CreditNote.invoiceId column ----
SET @cn_invoiceId_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'CreditNote'
    AND COLUMN_NAME = 'invoiceId'
);
SET @sql := IF(
  @cn_invoiceId_exists = 0,
  'ALTER TABLE `CreditNote` ADD COLUMN `invoiceId` INTEGER NULL AFTER `companyId`',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Index: CreditNote_companyId_invoiceId_idx
SET @cn_idx_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'CreditNote'
    AND INDEX_NAME = 'CreditNote_companyId_invoiceId_idx'
);
SET @sql := IF(
  @cn_idx_exists = 0,
  'CREATE INDEX `CreditNote_companyId_invoiceId_idx` ON `CreditNote`(`companyId`,`invoiceId`)',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- FK: CreditNote_invoiceId_fkey
SET @cn_fk_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'CreditNote'
    AND CONSTRAINT_NAME = 'CreditNote_invoiceId_fkey'
    AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(
  @cn_fk_exists = 0,
  'ALTER TABLE `CreditNote` ADD CONSTRAINT `CreditNote_invoiceId_fkey` FOREIGN KEY (`invoiceId`) REFERENCES `Invoice`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---- CreditNoteLine.invoiceLineId column ----
SET @cnl_invoiceLineId_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'CreditNoteLine'
    AND COLUMN_NAME = 'invoiceLineId'
);
SET @sql := IF(
  @cnl_invoiceLineId_exists = 0,
  'ALTER TABLE `CreditNoteLine` ADD COLUMN `invoiceLineId` INTEGER NULL AFTER `creditNoteId`',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Index: CreditNoteLine_invoiceLineId_idx
SET @cnl_idx_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'CreditNoteLine'
    AND INDEX_NAME = 'CreditNoteLine_invoiceLineId_idx'
);
SET @sql := IF(
  @cnl_idx_exists = 0,
  'CREATE INDEX `CreditNoteLine_invoiceLineId_idx` ON `CreditNoteLine`(`invoiceLineId`)',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- FK: CreditNoteLine_invoiceLineId_fkey
SET @cnl_fk_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'CreditNoteLine'
    AND CONSTRAINT_NAME = 'CreditNoteLine_invoiceLineId_fkey'
    AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(
  @cnl_fk_exists = 0,
  'ALTER TABLE `CreditNoteLine` ADD CONSTRAINT `CreditNoteLine_invoiceLineId_fkey` FOREIGN KEY (`invoiceLineId`) REFERENCES `InvoiceLine`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


