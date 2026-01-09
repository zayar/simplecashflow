-- Link Purchase Bills to Purchase Orders / Receipts (streamlined purchasing)

-- 1) Link PurchaseBill -> PurchaseOrder (optional, for "convert PO to bill" without receipt)
ALTER TABLE `PurchaseBill`
  ADD COLUMN `purchaseOrderId` INTEGER NULL;

CREATE INDEX `PurchaseBill_purchaseOrderId_idx` ON `PurchaseBill`(`purchaseOrderId`);

ALTER TABLE `PurchaseBill`
  ADD CONSTRAINT `PurchaseBill_purchaseOrderId_fkey`
  FOREIGN KEY (`purchaseOrderId`) REFERENCES `PurchaseOrder`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

-- 2) Link PurchaseBillLine -> PurchaseOrderLine (optional) and PurchaseReceiptLine (optional)
ALTER TABLE `PurchaseBillLine`
  ADD COLUMN `purchaseOrderLineId` INTEGER NULL,
  ADD COLUMN `purchaseReceiptLineId` INTEGER NULL;

CREATE INDEX `PurchaseBillLine_purchaseOrderLineId_idx` ON `PurchaseBillLine`(`purchaseOrderLineId`);
CREATE INDEX `PurchaseBillLine_purchaseReceiptLineId_idx` ON `PurchaseBillLine`(`purchaseReceiptLineId`);

ALTER TABLE `PurchaseBillLine`
  ADD CONSTRAINT `PurchaseBillLine_purchaseOrderLineId_fkey`
  FOREIGN KEY (`purchaseOrderLineId`) REFERENCES `PurchaseOrderLine`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `PurchaseBillLine_purchaseReceiptLineId_fkey`
  FOREIGN KEY (`purchaseReceiptLineId`) REFERENCES `PurchaseReceiptLine`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

