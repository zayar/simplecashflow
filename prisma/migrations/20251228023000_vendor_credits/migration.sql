-- Vendor Credits: create vendor credits + applications and extend stock move type for purchase returns

-- 1) Extend StockMove.type enum to include PURCHASE_RETURN
ALTER TABLE `StockMove`
  MODIFY `type` ENUM('OPENING','ADJUSTMENT','SALE_ISSUE','SALE_RETURN','PURCHASE_RECEIPT','PURCHASE_RETURN','TRANSFER_OUT','TRANSFER_IN') NOT NULL;

-- 2) VendorCredit
CREATE TABLE `VendorCredit` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `companyId` INT NOT NULL,
  `vendorId` INT NULL,
  `warehouseId` INT NOT NULL,
  `creditNumber` VARCHAR(191) NOT NULL,
  `status` ENUM('DRAFT','APPROVED','POSTED','VOID') NOT NULL,
  `creditDate` DATETIME(3) NOT NULL,
  `currency` VARCHAR(191) NULL,
  `total` DECIMAL(18,2) NOT NULL,
  `amountApplied` DECIMAL(18,2) NOT NULL DEFAULT 0,
  `journalEntryId` INT NULL,
  `voidedAt` DATETIME(3) NULL,
  `voidReason` TEXT NULL,
  `voidedByUserId` INT NULL,
  `voidJournalEntryId` INT NULL,
  `lastAdjustmentJournalEntryId` INT NULL,
  `updatedByUserId` INT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `VendorCredit_journalEntryId_key` (`journalEntryId`),
  UNIQUE INDEX `VendorCredit_voidJournalEntryId_key` (`voidJournalEntryId`),
  UNIQUE INDEX `VendorCredit_companyId_creditNumber_key` (`companyId`, `creditNumber`),
  INDEX `VendorCredit_companyId_creditDate_idx` (`companyId`, `creditDate`),
  INDEX `VendorCredit_companyId_status_idx` (`companyId`, `status`),
  INDEX `VendorCredit_companyId_vendorId_idx` (`companyId`, `vendorId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 3) VendorCreditLine
CREATE TABLE `VendorCreditLine` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `companyId` INT NOT NULL,
  `vendorCreditId` INT NOT NULL,
  `warehouseId` INT NOT NULL,
  `itemId` INT NOT NULL,
  `accountId` INT NULL,
  `description` VARCHAR(191) NULL,
  `quantity` DECIMAL(18,2) NOT NULL,
  `unitCost` DECIMAL(18,2) NOT NULL,
  `lineTotal` DECIMAL(18,2) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `VendorCreditLine_companyId_idx` (`companyId`),
  INDEX `VendorCreditLine_vendorCreditId_idx` (`vendorCreditId`),
  INDEX `VendorCreditLine_companyId_itemId_idx` (`companyId`, `itemId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 4) VendorCreditApplication (apply credits to bills)
CREATE TABLE `VendorCreditApplication` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `companyId` INT NOT NULL,
  `vendorCreditId` INT NOT NULL,
  `purchaseBillId` INT NOT NULL,
  `appliedDate` DATETIME(3) NOT NULL,
  `amount` DECIMAL(18,2) NOT NULL,
  `createdByUserId` INT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `VendorCreditApplication_companyId_appliedDate_idx` (`companyId`, `appliedDate`),
  INDEX `VendorCreditApplication_companyId_vendorCreditId_idx` (`companyId`, `vendorCreditId`),
  INDEX `VendorCreditApplication_companyId_purchaseBillId_idx` (`companyId`, `purchaseBillId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Foreign keys
ALTER TABLE `VendorCredit`
  ADD CONSTRAINT `VendorCredit_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `VendorCredit_vendorId_fkey` FOREIGN KEY (`vendorId`) REFERENCES `Vendor`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `VendorCredit_warehouseId_fkey` FOREIGN KEY (`warehouseId`) REFERENCES `Warehouse`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `VendorCredit_journalEntryId_fkey` FOREIGN KEY (`journalEntryId`) REFERENCES `JournalEntry`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `VendorCredit_voidedByUserId_fkey` FOREIGN KEY (`voidedByUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `VendorCredit_voidJournalEntryId_fkey` FOREIGN KEY (`voidJournalEntryId`) REFERENCES `JournalEntry`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `VendorCredit_lastAdjustmentJournalEntryId_fkey` FOREIGN KEY (`lastAdjustmentJournalEntryId`) REFERENCES `JournalEntry`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `VendorCredit_updatedByUserId_fkey` FOREIGN KEY (`updatedByUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `VendorCreditLine`
  ADD CONSTRAINT `VendorCreditLine_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `VendorCreditLine_vendorCreditId_fkey` FOREIGN KEY (`vendorCreditId`) REFERENCES `VendorCredit`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `VendorCreditLine_warehouseId_fkey` FOREIGN KEY (`warehouseId`) REFERENCES `Warehouse`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `VendorCreditLine_itemId_fkey` FOREIGN KEY (`itemId`) REFERENCES `Item`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `VendorCreditLine_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `VendorCreditApplication`
  ADD CONSTRAINT `VendorCreditApplication_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `VendorCreditApplication_vendorCreditId_fkey` FOREIGN KEY (`vendorCreditId`) REFERENCES `VendorCredit`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `VendorCreditApplication_purchaseBillId_fkey` FOREIGN KEY (`purchaseBillId`) REFERENCES `PurchaseBill`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `VendorCreditApplication_createdByUserId_fkey` FOREIGN KEY (`createdByUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;


