-- Add AccountBalance (daily per-account totals)

CREATE TABLE `AccountBalance` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `companyId` INTEGER NOT NULL,
  `accountId` INTEGER NOT NULL,
  `date` DATETIME(3) NOT NULL,
  `debitTotal` DECIMAL(18, 2) NOT NULL,
  `creditTotal` DECIMAL(18, 2) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`),
  UNIQUE INDEX `AccountBalance_companyId_accountId_date_key`(`companyId`, `accountId`, `date`),
  INDEX `AccountBalance_companyId_date_idx`(`companyId`, `date`),
  INDEX `AccountBalance_companyId_accountId_idx`(`companyId`, `accountId`),

  CONSTRAINT `AccountBalance_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `AccountBalance_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
