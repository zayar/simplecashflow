-- Add discount amount support for purchase bill lines (absolute amount per line).
ALTER TABLE `PurchaseBillLine`
  ADD COLUMN `discountAmount` DECIMAL(18, 2) NOT NULL DEFAULT 0 AFTER `unitCost`;


