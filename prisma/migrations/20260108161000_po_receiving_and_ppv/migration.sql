-- PO receiving line linkage + Purchase Price Variance (PPV) support

-- 1) Company PPV account link
ALTER TABLE `Company`
  ADD COLUMN `purchasePriceVarianceAccountId` INTEGER NULL;

CREATE INDEX `Company_purchasePriceVarianceAccountId_fkey` ON `Company`(`purchasePriceVarianceAccountId`);

ALTER TABLE `Company`
  ADD CONSTRAINT `Company_purchasePriceVarianceAccountId_fkey`
  FOREIGN KEY (`purchasePriceVarianceAccountId`) REFERENCES `Account`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

-- 2) Link PurchaseReceiptLine to PurchaseOrderLine (optional)
ALTER TABLE `PurchaseReceiptLine`
  ADD COLUMN `purchaseOrderLineId` INTEGER NULL;

CREATE INDEX `PurchaseReceiptLine_purchaseOrderLineId_idx` ON `PurchaseReceiptLine`(`purchaseOrderLineId`);

ALTER TABLE `PurchaseReceiptLine`
  ADD CONSTRAINT `PurchaseReceiptLine_purchaseOrderLineId_fkey`
  FOREIGN KEY (`purchaseOrderLineId`) REFERENCES `PurchaseOrderLine`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

