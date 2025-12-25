-- CreateTable: IntegrationEntityMap
CREATE TABLE `IntegrationEntityMap` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `companyId` INTEGER NOT NULL,
  `integration` VARCHAR(32) NOT NULL,
  `entityType` VARCHAR(32) NOT NULL,
  `externalId` VARCHAR(128) NOT NULL,
  `internalId` VARCHAR(128) NOT NULL,
  `metadata` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  -- NOTE: MySQL has a 64-character identifier limit. Keep index/constraint names short.
  UNIQUE INDEX `IEM_uq`(`companyId`, `integration`, `entityType`, `externalId`),
  INDEX `IEM_idx`(`companyId`, `integration`, `entityType`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Foreign keys
ALTER TABLE `IntegrationEntityMap`
  ADD CONSTRAINT `IEM_companyId_fkey`
  FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;


