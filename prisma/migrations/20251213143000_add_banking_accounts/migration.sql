-- CreateTable
CREATE TABLE `BankingAccount` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `companyId` INTEGER NOT NULL,
  `accountId` INTEGER NOT NULL,
  `kind` ENUM('CASH', 'BANK', 'E_WALLET', 'CREDIT_CARD') NOT NULL,
  `bankName` VARCHAR(191) NULL,
  `accountNumber` VARCHAR(191) NULL,
  `identifierCode` VARCHAR(191) NULL,
  `branch` VARCHAR(191) NULL,
  `description` TEXT NULL,
  `isPrimary` BOOLEAN NOT NULL DEFAULT false,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `BankingAccount_accountId_key`(`accountId`),
  INDEX `BankingAccount_companyId_idx`(`companyId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `BankingAccount` ADD CONSTRAINT `BankingAccount_companyId_fkey`
  FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BankingAccount` ADD CONSTRAINT `BankingAccount_accountId_fkey`
  FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;


