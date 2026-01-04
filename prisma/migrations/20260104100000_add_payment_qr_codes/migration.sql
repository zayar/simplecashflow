-- Add payment QR codes for customer self-service payments
ALTER TABLE `Company` ADD COLUMN `paymentQrCodes` JSON NULL;

