-- Vendor Advances / Supplier Prepayments

CREATE TABLE `VendorAdvance` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `companyId` INTEGER NOT NULL,
  `vendorId` INTEGER NOT NULL,
  `warehouseId` INTEGER NOT NULL,
  `advanceDate` DATETIME(3) NOT NULL,
  `currency` VARCHAR(191) NULL,
  `amount` DECIMAL(18,2) NOT NULL,
  `amountApplied` DECIMAL(18,2) NOT NULL DEFAULT 0,
  `bankAccountId` INTEGER NOT NULL,
  `prepaymentAccountId` INTEGER NOT NULL,
  `receivedVia` ENUM('CASH','BANK','E_WALLET','CREDIT_CARD') NULL,
  `reference` VARCHAR(191) NULL,
  `description` TEXT NULL,
  `journalEntryId` INTEGER NULL,
  `createdByUserId` INTEGER NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `VendorAdvance_journalEntryId_key` (`journalEntryId`),
  INDEX `VendorAdvance_companyId_advanceDate_idx` (`companyId`, `advanceDate`),
  INDEX `VendorAdvance_companyId_vendorId_idx` (`companyId`, `vendorId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `VendorAdvanceApplication` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `companyId` INTEGER NOT NULL,
  `vendorAdvanceId` INTEGER NOT NULL,
  `purchaseBillId` INTEGER NOT NULL,
  `appliedDate` DATETIME(3) NOT NULL,
  `amount` DECIMAL(18,2) NOT NULL,
  `journalEntryId` INTEGER NULL,
  `createdByUserId` INTEGER NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `VendorAdvanceApplication_journalEntryId_key` (`journalEntryId`),
  INDEX `VendorAdvanceApplication_companyId_appliedDate_idx` (`companyId`, `appliedDate`),
  INDEX `VendorAdvanceApplication_companyId_vendorAdvanceId_idx` (`companyId`, `vendorAdvanceId`),
  INDEX `VendorAdvanceApplication_companyId_purchaseBillId_idx` (`companyId`, `purchaseBillId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `VendorAdvance`
  ADD CONSTRAINT `VendorAdvance_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `VendorAdvance_vendorId_fkey` FOREIGN KEY (`vendorId`) REFERENCES `Vendor`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `VendorAdvance_warehouseId_fkey` FOREIGN KEY (`warehouseId`) REFERENCES `Warehouse`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `VendorAdvance_bankAccountId_fkey` FOREIGN KEY (`bankAccountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `VendorAdvance_prepaymentAccountId_fkey` FOREIGN KEY (`prepaymentAccountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `VendorAdvance_journalEntryId_fkey` FOREIGN KEY (`journalEntryId`) REFERENCES `JournalEntry`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `VendorAdvance_createdByUserId_fkey` FOREIGN KEY (`createdByUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `VendorAdvanceApplication`
  ADD CONSTRAINT `VendorAdvanceApplication_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `VendorAdvanceApplication_vendorAdvanceId_fkey` FOREIGN KEY (`vendorAdvanceId`) REFERENCES `VendorAdvance`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `VendorAdvanceApplication_purchaseBillId_fkey` FOREIGN KEY (`purchaseBillId`) REFERENCES `PurchaseBill`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `VendorAdvanceApplication_journalEntryId_fkey` FOREIGN KEY (`journalEntryId`) REFERENCES `JournalEntry`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `VendorAdvanceApplication_createdByUserId_fkey` FOREIGN KEY (`createdByUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

