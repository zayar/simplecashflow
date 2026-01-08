-- Allow credit note lines to be free-text (no Item) by making itemId nullable.
-- This is required for "clean returns" when the original invoice contains custom lines (InvoiceLine.itemId is nullable).

-- Drop existing foreign key first
ALTER TABLE `CreditNoteLine` DROP FOREIGN KEY `CreditNoteLine_itemId_fkey`;

-- Make itemId nullable
ALTER TABLE `CreditNoteLine` MODIFY `itemId` INTEGER NULL;

-- Re-add FK with safe delete behavior (keep credit note lines even if item is deleted)
ALTER TABLE `CreditNoteLine`
  ADD CONSTRAINT `CreditNoteLine_itemId_fkey`
  FOREIGN KEY (`itemId`) REFERENCES `Item`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;


