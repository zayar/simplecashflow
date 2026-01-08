-- Add phone fields to User (for OTP login)
ALTER TABLE `User`
  ADD COLUMN `phone` VARCHAR(32) NULL,
  ADD COLUMN `phoneVerifiedAt` DATETIME(3) NULL;

-- Unique phone per user (multiple NULLs allowed in MySQL)
CREATE UNIQUE INDEX `User_phone_key` ON `User`(`phone`);

-- CreateTable: LoginOtp (pre-auth OTP storage; not tenant-scoped)
CREATE TABLE `LoginOtp` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `phone` VARCHAR(32) NOT NULL,
  `codeHash` VARCHAR(191) NOT NULL,
  `purpose` VARCHAR(32) NOT NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  `consumedAt` DATETIME(3) NULL,
  `attempts` INTEGER NOT NULL DEFAULT 0,
  `requestedIp` VARCHAR(64) NULL,
  `verifiedIp` VARCHAR(64) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `LoginOtp_phone_purpose_createdAt_idx` (`phone`, `purpose`, `createdAt`),
  INDEX `LoginOtp_phone_purpose_expiresAt_idx` (`phone`, `purpose`, `expiresAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

