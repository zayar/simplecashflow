-- Allow invoice lines to be free-text (no Item) by making itemId nullable

-- Drop existing foreign key first (created in initial migration)
ALTER TABLE `InvoiceLine` DROP FOREIGN KEY `InvoiceLine_itemId_fkey`;

-- Make itemId nullable
ALTER TABLE `InvoiceLine` MODIFY `itemId` INTEGER NULL;

-- Re-add FK with safe delete behavior (keep invoice lines even if item is deleted)
ALTER TABLE `InvoiceLine`
  ADD CONSTRAINT `InvoiceLine_itemId_fkey`
  FOREIGN KEY (`itemId`) REFERENCES `Item`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;


