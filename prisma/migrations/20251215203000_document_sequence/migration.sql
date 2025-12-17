-- DocumentSequence: per-company incremental numbering for documents

CREATE TABLE `DocumentSequence` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `companyId` INTEGER NOT NULL,
  `key` VARCHAR(191) NOT NULL,
  `nextNumber` INTEGER NOT NULL DEFAULT 1,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `DocumentSequence_companyId_key_key`(`companyId`, `key`),
  INDEX `DocumentSequence_companyId_idx`(`companyId`),
  CONSTRAINT `DocumentSequence_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;


