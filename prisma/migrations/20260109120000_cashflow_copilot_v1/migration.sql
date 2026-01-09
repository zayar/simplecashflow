-- Cashflow Copilot v1: settings + recurring items

CREATE TABLE `CashflowSettings` (
  `companyId` INTEGER NOT NULL,
  `defaultArDelayDays` INTEGER NOT NULL DEFAULT 7,
  `defaultApDelayDays` INTEGER NOT NULL DEFAULT 0,
  `minCashBuffer` DECIMAL(18, 2) NOT NULL DEFAULT 0.00,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  PRIMARY KEY (`companyId`),
  CONSTRAINT `CashflowSettings_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `CashflowRecurringItem` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `companyId` INTEGER NOT NULL,
  `direction` ENUM('INFLOW', 'OUTFLOW') NOT NULL,
  `name` VARCHAR(128) NOT NULL,
  `amount` DECIMAL(18, 2) NOT NULL,
  `currency` VARCHAR(3) NULL,
  `startDate` DATETIME(3) NOT NULL,
  `endDate` DATETIME(3) NULL,
  `frequency` ENUM('WEEKLY', 'MONTHLY') NOT NULL,
  `interval` INTEGER NOT NULL DEFAULT 1,
  `isActive` BOOLEAN NOT NULL DEFAULT true,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`),
  INDEX `CashflowRecurringItem_companyId_isActive_idx` (`companyId`, `isActive`),
  INDEX `CashflowRecurringItem_companyId_startDate_idx` (`companyId`, `startDate`),
  CONSTRAINT `CashflowRecurringItem_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

