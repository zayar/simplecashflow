-- Add RBAC role to User
ALTER TABLE `User`
  ADD COLUMN `role` ENUM('OWNER','ACCOUNTANT','CLERK','VIEWER') NOT NULL DEFAULT 'OWNER';

-- CreateTable
CREATE TABLE `AuditLog` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `companyId` INTEGER NOT NULL,
  `userId` INTEGER NULL,
  `action` VARCHAR(191) NOT NULL,
  `entityType` VARCHAR(191) NOT NULL,
  `entityId` VARCHAR(191) NULL,
  `idempotencyKey` VARCHAR(191) NULL,
  `correlationId` VARCHAR(191) NULL,
  `metadata` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `AuditLog_companyId_createdAt_idx`(`companyId`, `createdAt`),
  INDEX `AuditLog_companyId_entityType_entityId_idx`(`companyId`, `entityType`, `entityId`),
  INDEX `AuditLog_companyId_userId_createdAt_idx`(`companyId`, `userId`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AuditLog`
  ADD CONSTRAINT `AuditLog_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AuditLog`
  ADD CONSTRAINT `AuditLog_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;


