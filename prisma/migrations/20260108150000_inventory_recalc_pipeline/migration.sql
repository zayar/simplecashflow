-- Backdated inventory revaluation pipeline support
-- 1) Coalesce recalc requests per company
-- 2) Idempotent per-source JE valuation adjustments

CREATE TABLE `InventoryRecalcState` (
  `companyId` INTEGER NOT NULL,
  `requestedFromDate` DATETIME(3) NULL,
  `requestedAt` DATETIME(3) NULL,
  `runningAt` DATETIME(3) NULL,
  `lockedAt` DATETIME(3) NULL,
  `lockId` VARCHAR(64) NULL,
  `attempts` INTEGER NOT NULL DEFAULT 0,
  `lastError` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  PRIMARY KEY (`companyId`),
  INDEX `InventoryRecalcState_requestedAt_idx`(`requestedAt`),
  INDEX `InventoryRecalcState_runningAt_idx`(`runningAt`),
  INDEX `InventoryRecalcState_lockedAt_idx`(`lockedAt`),

  CONSTRAINT `InventoryRecalcState_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `JournalEntryInventoryValuation` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `companyId` INTEGER NOT NULL,
  `sourceJournalEntryId` INTEGER NOT NULL,
  `lastComputedCogs` DECIMAL(18, 2) NOT NULL DEFAULT 0.00,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`),
  -- MySQL identifier names max 64 chars; keep indexes short.
  UNIQUE INDEX `JEIV_uq`(`companyId`, `sourceJournalEntryId`),
  INDEX `JEIV_companyId_idx`(`companyId`),
  INDEX `JEIV_sourceJeId_idx`(`sourceJournalEntryId`),

  CONSTRAINT `JournalEntryInventoryValuation_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `JournalEntryInventoryValuation_sourceJournalEntryId_fkey` FOREIGN KEY (`sourceJournalEntryId`) REFERENCES `JournalEntry`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

