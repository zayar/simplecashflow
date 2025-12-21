-- CreateTable: CreditNote
CREATE TABLE `CreditNote` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `companyId` INTEGER NOT NULL,
  `invoiceId` INTEGER NULL,
  `customerId` INTEGER NOT NULL,
  `creditNoteNumber` VARCHAR(191) NOT NULL,
  `status` ENUM('DRAFT','POSTED') NOT NULL,
  `creditNoteDate` DATETIME(3) NOT NULL,
  `currency` VARCHAR(191) NULL,
  `total` DECIMAL(18,2) NOT NULL,
  `journalEntryId` INTEGER NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `CreditNote_companyId_creditNoteNumber_key`(`companyId`,`creditNoteNumber`),
  UNIQUE INDEX `CreditNote_journalEntryId_key`(`journalEntryId`),
  INDEX `CreditNote_companyId_creditNoteDate_idx`(`companyId`,`creditNoteDate`),
  INDEX `CreditNote_companyId_status_idx`(`companyId`,`status`),
  INDEX `CreditNote_companyId_invoiceId_idx`(`companyId`,`invoiceId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: CreditNoteLine
CREATE TABLE `CreditNoteLine` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `companyId` INTEGER NOT NULL,
  `creditNoteId` INTEGER NOT NULL,
  `invoiceLineId` INTEGER NULL,
  `itemId` INTEGER NOT NULL,
  `description` VARCHAR(191) NULL,
  `quantity` DECIMAL(18,2) NOT NULL,
  `unitPrice` DECIMAL(18,2) NOT NULL,
  `lineTotal` DECIMAL(18,2) NOT NULL,

  INDEX `CreditNoteLine_companyId_idx`(`companyId`),
  INDEX `CreditNoteLine_creditNoteId_idx`(`creditNoteId`),
  INDEX `CreditNoteLine_invoiceLineId_idx`(`invoiceLineId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Foreign keys
ALTER TABLE `CreditNote`
  ADD CONSTRAINT `CreditNote_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `CreditNote`
  ADD CONSTRAINT `CreditNote_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `CreditNote`
  ADD CONSTRAINT `CreditNote_invoiceId_fkey` FOREIGN KEY (`invoiceId`) REFERENCES `Invoice`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `CreditNote`
  ADD CONSTRAINT `CreditNote_journalEntryId_fkey` FOREIGN KEY (`journalEntryId`) REFERENCES `JournalEntry`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `CreditNoteLine`
  ADD CONSTRAINT `CreditNoteLine_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `CreditNoteLine`
  ADD CONSTRAINT `CreditNoteLine_creditNoteId_fkey` FOREIGN KEY (`creditNoteId`) REFERENCES `CreditNote`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `CreditNoteLine`
  ADD CONSTRAINT `CreditNoteLine_invoiceLineId_fkey` FOREIGN KEY (`invoiceLineId`) REFERENCES `InvoiceLine`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `CreditNoteLine`
  ADD CONSTRAINT `CreditNoteLine_itemId_fkey` FOREIGN KEY (`itemId`) REFERENCES `Item`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;


