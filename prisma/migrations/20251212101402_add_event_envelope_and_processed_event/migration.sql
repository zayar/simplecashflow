-- Step 1: Add new columns as nullable (temporarily)
ALTER TABLE `Event` 
  ADD COLUMN `eventId` VARCHAR(191) NULL,
  ADD COLUMN `eventType` VARCHAR(191) NULL,
  ADD COLUMN `schemaVersion` VARCHAR(191) NULL,
  ADD COLUMN `occurredAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ADD COLUMN `source` VARCHAR(191) NULL;

-- Step 2: Backfill existing rows with generated values
-- Generate UUIDs for eventId, derive eventType from type, set schemaVersion to 'v1', and use createdAt as occurredAt
UPDATE `Event` 
SET 
  `eventId` = UUID(),
  `eventType` = CASE 
    WHEN `type` = 'JournalEntryCreated' THEN 'journal.entry.created'
    WHEN `type` = 'PitiSaleImported' THEN 'integration.piti.sale.imported'
    ELSE CONCAT('legacy.', LOWER(REPLACE(`type`, ' ', '.')))
  END,
  `schemaVersion` = 'v1',
  `occurredAt` = `createdAt`,
  `source` = 'cashflow-api'
WHERE `eventId` IS NULL;

-- Step 3: Make columns required (NOT NULL)
ALTER TABLE `Event`
  MODIFY COLUMN `eventId` VARCHAR(191) NOT NULL,
  MODIFY COLUMN `eventType` VARCHAR(191) NOT NULL,
  MODIFY COLUMN `schemaVersion` VARCHAR(191) NOT NULL;

-- Step 4: Add unique constraint on eventId
CREATE UNIQUE INDEX `Event_eventId_key` ON `Event`(`eventId`);

-- Step 5: Create ProcessedEvent table
CREATE TABLE `ProcessedEvent` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `eventId` VARCHAR(191) NOT NULL,
    `processedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ProcessedEvent_eventId_key`(`eventId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

