-- Add optional attachment URL to Expense (receipt photo, invoice scan)
ALTER TABLE `Expense` ADD COLUMN `attachmentUrl` TEXT NULL;


