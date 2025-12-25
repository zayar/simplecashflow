-- Add optional branch tagging (Warehouse-as-Branch) to journal entries and invoices.
-- Keep nullable + backward compatible.

ALTER TABLE `JournalEntry` ADD COLUMN `warehouseId` INT NULL;
ALTER TABLE `Invoice` ADD COLUMN `warehouseId` INT NULL;

-- Indexes (MySQL requires an index where the FK column is the left-most prefix).
CREATE INDEX `JE_wh_idx` ON `JournalEntry`(`warehouseId`);
CREATE INDEX `JE_co_wh_idx` ON `JournalEntry`(`companyId`, `warehouseId`);

CREATE INDEX `Inv_wh_idx` ON `Invoice`(`warehouseId`);
CREATE INDEX `Inv_co_wh_idx` ON `Invoice`(`companyId`, `warehouseId`);

-- Foreign keys (short names to avoid MySQL 64-char identifier limit)
ALTER TABLE `JournalEntry`
  ADD CONSTRAINT `JE_wh_fk` FOREIGN KEY (`warehouseId`) REFERENCES `Warehouse`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `Invoice`
  ADD CONSTRAINT `Inv_wh_fk` FOREIGN KEY (`warehouseId`) REFERENCES `Warehouse`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;


