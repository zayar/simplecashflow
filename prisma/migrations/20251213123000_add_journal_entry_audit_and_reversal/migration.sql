-- AlterTable
ALTER TABLE `JournalEntry`
    ADD COLUMN `createdByUserId` INTEGER NULL,
    ADD COLUMN `postedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    ADD COLUMN `reversalOfJournalEntryId` INTEGER NULL,
    ADD COLUMN `reversalReason` TEXT NULL;

-- CreateIndex
CREATE UNIQUE INDEX `JournalEntry_reversalOfJournalEntryId_key` ON `JournalEntry`(`reversalOfJournalEntryId`);

-- AddForeignKey
ALTER TABLE `JournalEntry` ADD CONSTRAINT `JournalEntry_createdByUserId_fkey`
    FOREIGN KEY (`createdByUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `JournalEntry` ADD CONSTRAINT `JournalEntry_reversalOfJournalEntryId_fkey`
    FOREIGN KEY (`reversalOfJournalEntryId`) REFERENCES `JournalEntry`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;


