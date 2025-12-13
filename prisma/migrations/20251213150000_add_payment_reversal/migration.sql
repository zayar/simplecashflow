-- AlterTable
ALTER TABLE `Payment`
  ADD COLUMN `reversedAt` DATETIME(3) NULL,
  ADD COLUMN `reversalReason` TEXT NULL,
  ADD COLUMN `reversalJournalEntryId` INTEGER NULL,
  ADD COLUMN `reversedByUserId` INTEGER NULL;

-- CreateIndex
CREATE UNIQUE INDEX `Payment_reversalJournalEntryId_key` ON `Payment`(`reversalJournalEntryId`);

-- AddForeignKey
ALTER TABLE `Payment` ADD CONSTRAINT `Payment_reversalJournalEntryId_fkey`
  FOREIGN KEY (`reversalJournalEntryId`) REFERENCES `JournalEntry`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Payment` ADD CONSTRAINT `Payment_reversedByUserId_fkey`
  FOREIGN KEY (`reversedByUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;


