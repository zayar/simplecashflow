-- Add Currency + ExchangeRate tables (reference-only exchange rates; no impact on ledger posting)
-- MySQL

CREATE TABLE `Currency` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `companyId` INT NOT NULL,
  `code` VARCHAR(3) NOT NULL,
  `name` VARCHAR(191) NULL,
  `symbol` VARCHAR(16) NULL,
  `isActive` BOOLEAN NOT NULL DEFAULT true,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `Currency_companyId_code_key` (`companyId`, `code`),
  INDEX `Currency_companyId_idx` (`companyId`),
  CONSTRAINT `Currency_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE `ExchangeRate` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `companyId` INT NOT NULL,
  `currencyId` INT NOT NULL,
  `baseCurrency` VARCHAR(3) NOT NULL,
  `rateToBase` DECIMAL(18, 8) NOT NULL,
  `asOfDate` DATETIME(3) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `ExchangeRate_companyId_currencyId_asOfDate_key` (`companyId`, `currencyId`, `asOfDate`),
  INDEX `ExchangeRate_companyId_currencyId_asOfDate_idx` (`companyId`, `currencyId`, `asOfDate`),
  INDEX `ExchangeRate_companyId_asOfDate_idx` (`companyId`, `asOfDate`),
  CONSTRAINT `ExchangeRate_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `ExchangeRate_currencyId_fkey` FOREIGN KEY (`currencyId`) REFERENCES `Currency`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
);


