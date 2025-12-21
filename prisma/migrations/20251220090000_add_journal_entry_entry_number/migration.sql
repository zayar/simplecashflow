-- Add gapless journal entry numbering (audit-friendly)
-- - Adds JournalEntry.entryNumber (distinct from PK id)
-- - Backfills existing rows deterministically per (companyId, year(date))
-- - Seeds DocumentSequence so new postings continue without gaps

-- 1) Add nullable column first so existing databases can be migrated safely
ALTER TABLE `JournalEntry`
  ADD COLUMN `entryNumber` VARCHAR(32) NULL;

-- 2) Create uniqueness constraint (MySQL allows multiple NULLs, which is ok during backfill)
CREATE UNIQUE INDEX `JournalEntry_companyId_entryNumber_key`
  ON `JournalEntry`(`companyId`, `entryNumber`);

-- Helpful query index for reports / listings
CREATE INDEX `JournalEntry_companyId_date_idx`
  ON `JournalEntry`(`companyId`, `date`);

-- 3) Backfill existing journal entries:
-- Gapless per company per year based on ledger date then id (deterministic).
WITH ranked AS (
  SELECT
    `id`,
    `companyId`,
    YEAR(`date`) AS `y`,
    ROW_NUMBER() OVER (
      PARTITION BY `companyId`, YEAR(`date`)
      ORDER BY `date` ASC, `id` ASC
    ) AS `seq`
  FROM `JournalEntry`
)
UPDATE `JournalEntry` je
JOIN ranked r ON r.id = je.id
SET je.entryNumber = CONCAT('JE-', r.y, '-', LPAD(r.seq, 4, '0'))
WHERE je.entryNumber IS NULL;

-- 4) Seed DocumentSequence for each (companyId, year) so new entries continue after backfill.
-- Key format: JOURNAL_ENTRY:<year>
INSERT INTO `DocumentSequence` (`companyId`, `key`, `nextNumber`, `createdAt`, `updatedAt`)
SELECT
  `companyId`,
  CONCAT('JOURNAL_ENTRY:', YEAR(`date`)) AS `key`,
  MAX(CAST(SUBSTRING_INDEX(`entryNumber`, '-', -1) AS UNSIGNED)) + 1 AS `nextNumber`,
  CURRENT_TIMESTAMP(3) AS `createdAt`,
  CURRENT_TIMESTAMP(3) AS `updatedAt`
FROM `JournalEntry`
GROUP BY `companyId`, YEAR(`date`)
ON DUPLICATE KEY UPDATE
  -- NOTE: MySQL supports VALUES() for ON DUPLICATE KEY UPDATE with INSERT...SELECT.
  -- VALUES() is deprecated in newer MySQL but still widely supported; Cloud SQL MySQL accepts it.
  `nextNumber` = GREATEST(`DocumentSequence`.`nextNumber`, VALUES(`nextNumber`)),
  `updatedAt` = CURRENT_TIMESTAMP(3);

-- 5) Make the column required after backfill
ALTER TABLE `JournalEntry`
  MODIFY COLUMN `entryNumber` VARCHAR(32) NOT NULL;


