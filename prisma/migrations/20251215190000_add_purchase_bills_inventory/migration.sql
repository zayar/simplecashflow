-- Purchase Bills (Inventory purchases / receiving)
-- Adds PurchaseBill + PurchaseBillLine and extends StockMoveType enum with PURCHASE_RECEIPT

-- 1) Extend StockMove.type enum
ALTER TABLE `StockMove`
  MODIFY `type` ENUM('OPENING','ADJUSTMENT','SALE_ISSUE','PURCHASE_RECEIPT','TRANSFER_OUT','TRANSFER_IN') NOT NULL;

-- 2) PurchaseBillStatus enum
-- (MySQL enum is stored per-column, Prisma will create column enum types as needed)

-- 3) PurchaseBill
CREATE TABLE `PurchaseBill` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `companyId` INTEGER NOT NULL,
  `vendorId` INTEGER NULL,
  `warehouseId` INTEGER NOT NULL,
  `billNumber` VARCHAR(191) NOT NULL,
  `status` ENUM('DRAFT','POSTED','PARTIAL','PAID') NOT NULL,
  `billDate` DATETIME(3) NOT NULL,
  `dueDate` DATETIME(3) NULL,
  `currency` VARCHAR(191) NULL,
  `total` DECIMAL(18, 2) NOT NULL,
  `amountPaid` DECIMAL(18, 2) NOT NULL DEFAULT 0,
  `journalEntryId` INTEGER NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`),
  UNIQUE INDEX `PurchaseBill_companyId_billNumber_key`(`companyId`, `billNumber`),
  UNIQUE INDEX `PurchaseBill_journalEntryId_key`(`journalEntryId`),
  INDEX `PurchaseBill_companyId_billDate_idx`(`companyId`, `billDate`),
  INDEX `PurchaseBill_companyId_status_idx`(`companyId`, `status`),

  CONSTRAINT `PurchaseBill_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `PurchaseBill_vendorId_fkey` FOREIGN KEY (`vendorId`) REFERENCES `Vendor`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `PurchaseBill_warehouseId_fkey` FOREIGN KEY (`warehouseId`) REFERENCES `Warehouse`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `PurchaseBill_journalEntryId_fkey` FOREIGN KEY (`journalEntryId`) REFERENCES `JournalEntry`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 4) PurchaseBillLine
CREATE TABLE `PurchaseBillLine` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `companyId` INTEGER NOT NULL,
  `purchaseBillId` INTEGER NOT NULL,
  `warehouseId` INTEGER NOT NULL,
  `itemId` INTEGER NOT NULL,
  `description` VARCHAR(191) NULL,
  `quantity` DECIMAL(18, 2) NOT NULL,
  `unitCost` DECIMAL(18, 2) NOT NULL,
  `lineTotal` DECIMAL(18, 2) NOT NULL,

  PRIMARY KEY (`id`),
  INDEX `PurchaseBillLine_companyId_idx`(`companyId`),
  INDEX `PurchaseBillLine_purchaseBillId_idx`(`purchaseBillId`),
  INDEX `PurchaseBillLine_companyId_itemId_idx`(`companyId`, `itemId`),

  CONSTRAINT `PurchaseBillLine_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `PurchaseBillLine_purchaseBillId_fkey` FOREIGN KEY (`purchaseBillId`) REFERENCES `PurchaseBill`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `PurchaseBillLine_warehouseId_fkey` FOREIGN KEY (`warehouseId`) REFERENCES `Warehouse`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `PurchaseBillLine_itemId_fkey` FOREIGN KEY (`itemId`) REFERENCES `Item`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;


