-- Add outbox + envelope metadata fields to Event
ALTER TABLE `Event`
  ADD COLUMN `partitionKey` VARCHAR(191) NULL,
  ADD COLUMN `correlationId` VARCHAR(191) NULL,
  ADD COLUMN `causationId` VARCHAR(191) NULL,
  ADD COLUMN `aggregateType` VARCHAR(191) NULL,
  ADD COLUMN `aggregateId` VARCHAR(191) NULL,
  ADD COLUMN `publishedAt` DATETIME(3) NULL,
  ADD COLUMN `nextPublishAttemptAt` DATETIME(3) NULL DEFAULT CURRENT_TIMESTAMP(3),
  ADD COLUMN `publishAttempts` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `lastPublishError` TEXT NULL,
  ADD COLUMN `lockedAt` DATETIME(3) NULL,
  ADD COLUMN `lockId` VARCHAR(191) NULL;

-- Helpful indexes for publisher queries
CREATE INDEX `Event_publishedAt_nextPublishAttemptAt_idx`
  ON `Event`(`publishedAt`, `nextPublishAttemptAt`);

CREATE INDEX `Event_lockedAt_idx`
  ON `Event`(`lockedAt`);

CREATE INDEX `Event_companyId_occurredAt_idx`
  ON `Event`(`companyId`, `occurredAt`);

-- Backfill: mark legacy events as already published so the new publisher
-- does NOT re-publish historical data.
-- We identify legacy rows by missing Step 1 envelope metadata.
UPDATE `Event`
SET
  `publishedAt` = `createdAt`,
  `nextPublishAttemptAt` = NULL
WHERE
  `publishedAt` IS NULL
  AND `partitionKey` IS NULL
  AND `correlationId` IS NULL
  AND `aggregateType` IS NULL
  AND `aggregateId` IS NULL;

