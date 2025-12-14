-- Period Close (month-end/year-end) support
-- Creates a record linking a closing JournalEntry to a period, preventing double-close.

CREATE TABLE `PeriodClose` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `companyId` INTEGER NOT NULL,
  `fromDate` DATETIME(3) NOT NULL,
  `toDate` DATETIME(3) NOT NULL,
  `journalEntryId` INTEGER NOT NULL,
  `createdByUserId` INTEGER NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE INDEX `PeriodClose_journalEntryId_key`(`journalEntryId`),
  UNIQUE INDEX `PeriodClose_companyId_fromDate_toDate_key`(`companyId`, `fromDate`, `toDate`),
  INDEX `PeriodClose_companyId_toDate_idx`(`companyId`, `toDate`),

  CONSTRAINT `PeriodClose_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `PeriodClose_journalEntryId_fkey` FOREIGN KEY (`journalEntryId`) REFERENCES `JournalEntry`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `PeriodClose_createdByUserId_fkey` FOREIGN KEY (`createdByUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

