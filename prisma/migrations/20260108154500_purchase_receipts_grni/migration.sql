-- Purchase Receipts + GRNI support

-- 1) Company GRNI account link (nullable, safe)
ALTER TABLE `Company`
  ADD COLUMN `goodsReceivedNotInvoicedAccountId` INTEGER NULL;

CREATE INDEX `Company_goodsReceivedNotInvoicedAccountId_fkey` ON `Company`(`goodsReceivedNotInvoicedAccountId`);

ALTER TABLE `Company`
  ADD CONSTRAINT `Company_goodsReceivedNotInvoicedAccountId_fkey`
  FOREIGN KEY (`goodsReceivedNotInvoicedAccountId`) REFERENCES `Account`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

-- 2) PurchaseReceipt tables (non-destructive, additive)
CREATE TABLE `PurchaseReceipt` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `companyId` INTEGER NOT NULL,
  `vendorId` INTEGER NULL,
  `purchaseOrderId` INTEGER NULL,
  `warehouseId` INTEGER NOT NULL,
  `receiptNumber` VARCHAR(191) NOT NULL,
  `status` ENUM('DRAFT','POSTED','VOID') NOT NULL,
  `receiptDate` DATETIME(3) NOT NULL,
  `expectedDate` DATETIME(3) NULL,
  `currency` VARCHAR(3) NULL,
  `total` DECIMAL(18, 2) NOT NULL,
  `journalEntryId` INTEGER NULL,
  `voidJournalEntryId` INTEGER NULL,
  `voidedAt` DATETIME(3) NULL,
  `voidReason` TEXT NULL,
  `createdByUserId` INTEGER NULL,
  `updatedByUserId` INTEGER NULL,
  `voidedByUserId` INTEGER NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`),
  UNIQUE INDEX `PurchaseReceipt_companyId_receiptNumber_key`(`companyId`, `receiptNumber`),
  UNIQUE INDEX `PurchaseReceipt_journalEntryId_key`(`journalEntryId`),
  UNIQUE INDEX `PurchaseReceipt_voidJournalEntryId_key`(`voidJournalEntryId`),
  INDEX `PurchaseReceipt_companyId_receiptDate_idx`(`companyId`, `receiptDate`),
  INDEX `PurchaseReceipt_companyId_status_idx`(`companyId`, `status`),
  INDEX `PurchaseReceipt_vendorId_idx`(`vendorId`),
  INDEX `PurchaseReceipt_purchaseOrderId_idx`(`purchaseOrderId`),
  INDEX `PurchaseReceipt_warehouseId_fkey`(`warehouseId`),

  CONSTRAINT `PurchaseReceipt_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `PurchaseReceipt_vendorId_fkey` FOREIGN KEY (`vendorId`) REFERENCES `Vendor`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `PurchaseReceipt_purchaseOrderId_fkey` FOREIGN KEY (`purchaseOrderId`) REFERENCES `PurchaseOrder`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `PurchaseReceipt_warehouseId_fkey` FOREIGN KEY (`warehouseId`) REFERENCES `Warehouse`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `PurchaseReceipt_journalEntryId_fkey` FOREIGN KEY (`journalEntryId`) REFERENCES `JournalEntry`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `PurchaseReceipt_voidJournalEntryId_fkey` FOREIGN KEY (`voidJournalEntryId`) REFERENCES `JournalEntry`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PurchaseReceiptLine` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `companyId` INTEGER NOT NULL,
  `purchaseReceiptId` INTEGER NOT NULL,
  `warehouseId` INTEGER NOT NULL,
  `itemId` INTEGER NOT NULL,
  `description` TEXT NULL,
  `quantity` DECIMAL(18, 2) NOT NULL,
  `unitCost` DECIMAL(18, 2) NOT NULL,
  `discountAmount` DECIMAL(18, 2) NOT NULL DEFAULT 0.00,
  `lineTotal` DECIMAL(18, 2) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`),
  INDEX `PurchaseReceiptLine_companyId_idx`(`companyId`),
  INDEX `PurchaseReceiptLine_purchaseReceiptId_idx`(`purchaseReceiptId`),
  INDEX `PurchaseReceiptLine_companyId_itemId_idx`(`companyId`, `itemId`),
  INDEX `PurchaseReceiptLine_itemId_fkey`(`itemId`),
  INDEX `PurchaseReceiptLine_warehouseId_fkey`(`warehouseId`),

  CONSTRAINT `PurchaseReceiptLine_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `PurchaseReceiptLine_purchaseReceiptId_fkey` FOREIGN KEY (`purchaseReceiptId`) REFERENCES `PurchaseReceipt`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `PurchaseReceiptLine_itemId_fkey` FOREIGN KEY (`itemId`) REFERENCES `Item`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `PurchaseReceiptLine_warehouseId_fkey` FOREIGN KEY (`warehouseId`) REFERENCES `Warehouse`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 3) Optional one-to-one link: PurchaseBill -> PurchaseReceipt (so bill can clear GRNI without double stock posting)
ALTER TABLE `PurchaseBill`
  ADD COLUMN `purchaseReceiptId` INTEGER NULL;

CREATE UNIQUE INDEX `PurchaseBill_purchaseReceiptId_key` ON `PurchaseBill`(`purchaseReceiptId`);
CREATE INDEX `PurchaseBill_purchaseReceiptId_idx` ON `PurchaseBill`(`purchaseReceiptId`);

ALTER TABLE `PurchaseBill`
  ADD CONSTRAINT `PurchaseBill_purchaseReceiptId_fkey`
  FOREIGN KEY (`purchaseReceiptId`) REFERENCES `PurchaseReceipt`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

