-- Add payment attachment URL for payment proofs
ALTER TABLE `Payment` ADD COLUMN `attachmentUrl` TEXT NULL;

-- Add pending payment proofs to Invoice (customer-submitted before owner records)
ALTER TABLE `Invoice` ADD COLUMN `pendingPaymentProofs` JSON NULL;

