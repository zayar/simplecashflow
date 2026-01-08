-- Vendor opening balance + vendor currency + banking account currency

ALTER TABLE `Vendor`
  ADD COLUMN `currency` VARCHAR(3) NULL,
  ADD COLUMN `openingBalance` DECIMAL(18,2) NULL;

ALTER TABLE `BankingAccount`
  ADD COLUMN `currency` VARCHAR(3) NULL;

