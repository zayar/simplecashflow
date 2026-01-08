-- Landed cost allocations for bills linked to receipts

CREATE TABLE `PurchaseBillLandedCostAllocation` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `companyId` INTEGER NOT NULL,
  `purchaseBillId` INTEGER NOT NULL,
  `purchaseReceiptId` INTEGER NOT NULL,
  `purchaseReceiptLineId` INTEGER NOT NULL,
  `amount` DECIMAL(18, 2) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  INDEX `PBLC_companyId_idx`(`companyId`),
  INDEX `PBLC_purchaseBillId_idx`(`purchaseBillId`),
  INDEX `PBLC_purchaseReceiptId_idx`(`purchaseReceiptId`),
  INDEX `PBLC_purchaseReceiptLineId_idx`(`purchaseReceiptLineId`),

  CONSTRAINT `PBLC_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `PBLC_purchaseBillId_fkey` FOREIGN KEY (`purchaseBillId`) REFERENCES `PurchaseBill`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `PBLC_purchaseReceiptId_fkey` FOREIGN KEY (`purchaseReceiptId`) REFERENCES `PurchaseReceipt`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `PBLC_purchaseReceiptLineId_fkey` FOREIGN KEY (`purchaseReceiptLineId`) REFERENCES `PurchaseReceiptLine`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

