-- Add company profile fields: base currency, time zone, fiscal year start month
-- MySQL

ALTER TABLE `Company`
  ADD COLUMN `baseCurrency` VARCHAR(191) NULL,
  ADD COLUMN `timeZone` VARCHAR(191) NULL,
  ADD COLUMN `fiscalYearStartMonth` INT NULL DEFAULT 1;


