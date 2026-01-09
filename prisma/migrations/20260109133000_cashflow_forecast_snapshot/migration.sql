-- Cashflow forecast snapshots (cached per company/day/scenario)

CREATE TABLE `CashflowForecastSnapshot` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `companyId` INTEGER NOT NULL,
  `scenario` VARCHAR(24) NOT NULL,
  `asOfDate` DATETIME(3) NOT NULL,
  `computedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `payload` JSON NOT NULL,

  PRIMARY KEY (`id`),
  UNIQUE INDEX `CFS_uq` (`companyId`, `scenario`, `asOfDate`),
  INDEX `CFS_company_computedAt_idx` (`companyId`, `computedAt`),
  INDEX `CFS_company_scenario_computedAt_idx` (`companyId`, `scenario`, `computedAt`),
  CONSTRAINT `CashflowForecastSnapshot_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

