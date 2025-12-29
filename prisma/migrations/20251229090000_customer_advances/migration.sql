-- Customer Advances: record customer deposits/advances and apply to invoices

CREATE TABLE `CustomerAdvance` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `companyId` INT NOT NULL,
  `customerId` INT NOT NULL,
  `warehouseId` INT NOT NULL,
  `advanceDate` DATETIME(3) NOT NULL,
  `currency` VARCHAR(191) NULL,
  `amount` DECIMAL(18,2) NOT NULL,
  `amountApplied` DECIMAL(18,2) NOT NULL DEFAULT 0,
  `bankAccountId` INT NOT NULL,
  `liabilityAccountId` INT NOT NULL,
  `receivedVia` ENUM('CASH','BANK','E_WALLET','CREDIT_CARD') NULL,
  `reference` VARCHAR(191) NULL,
  `description` TEXT NULL,
  `journalEntryId` INT NULL,
  `createdByUserId` INT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `CustomerAdvance_journalEntryId_key` (`journalEntryId`),
  INDEX `CustomerAdvance_companyId_advanceDate_idx` (`companyId`, `advanceDate`),
  INDEX `CustomerAdvance_companyId_customerId_idx` (`companyId`, `customerId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `CustomerAdvanceApplication` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `companyId` INT NOT NULL,
  `customerAdvanceId` INT NOT NULL,
  `invoiceId` INT NOT NULL,
  `appliedDate` DATETIME(3) NOT NULL,
  `amount` DECIMAL(18,2) NOT NULL,
  `journalEntryId` INT NULL,
  `createdByUserId` INT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `CustomerAdvanceApplication_journalEntryId_key` (`journalEntryId`),
  INDEX `CustomerAdvanceApplication_companyId_appliedDate_idx` (`companyId`, `appliedDate`),
  INDEX `CustomerAdvanceApplication_companyId_customerAdvanceId_idx` (`companyId`, `customerAdvanceId`),
  INDEX `CustomerAdvanceApplication_companyId_invoiceId_idx` (`companyId`, `invoiceId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Foreign keys
ALTER TABLE `CustomerAdvance`
  ADD CONSTRAINT `CustomerAdvance_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `CustomerAdvance_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `CustomerAdvance_warehouseId_fkey` FOREIGN KEY (`warehouseId`) REFERENCES `Warehouse`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `CustomerAdvance_bankAccountId_fkey` FOREIGN KEY (`bankAccountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `CustomerAdvance_liabilityAccountId_fkey` FOREIGN KEY (`liabilityAccountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `CustomerAdvance_journalEntryId_fkey` FOREIGN KEY (`journalEntryId`) REFERENCES `JournalEntry`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `CustomerAdvance_createdByUserId_fkey` FOREIGN KEY (`createdByUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `CustomerAdvanceApplication`
  ADD CONSTRAINT `CustomerAdvanceApplication_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `CustomerAdvanceApplication_customerAdvanceId_fkey` FOREIGN KEY (`customerAdvanceId`) REFERENCES `CustomerAdvance`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `CustomerAdvanceApplication_invoiceId_fkey` FOREIGN KEY (`invoiceId`) REFERENCES `Invoice`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `CustomerAdvanceApplication_journalEntryId_fkey` FOREIGN KEY (`journalEntryId`) REFERENCES `JournalEntry`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `CustomerAdvanceApplication_createdByUserId_fkey` FOREIGN KEY (`createdByUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;


