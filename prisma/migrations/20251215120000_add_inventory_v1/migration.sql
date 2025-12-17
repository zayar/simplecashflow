-- Inventory V1 (Accounting stock + WAC)
-- Adds:
-- - Warehouse
-- - StockBalance (qty + avg cost + value per item/location)
-- - StockMove (immutable audit trail for stock movements)
-- - Company inventory settings + default warehouse
-- - Item inventory tracking fields

-- 1) Warehouse
CREATE TABLE `Warehouse` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `companyId` INTEGER NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `isDefault` BOOLEAN NOT NULL DEFAULT false,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`),
  UNIQUE INDEX `Warehouse_companyId_name_key`(`companyId`, `name`),
  INDEX `Warehouse_companyId_idx`(`companyId`),

  CONSTRAINT `Warehouse_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 2) Company inventory settings + default warehouse pointer
ALTER TABLE `Company`
  ADD COLUMN `inventoryAssetAccountId` INTEGER NULL,
  ADD COLUMN `cogsAccountId` INTEGER NULL,
  ADD COLUMN `openingBalanceEquityAccountId` INTEGER NULL,
  ADD COLUMN `defaultWarehouseId` INTEGER NULL;

ALTER TABLE `Company`
  ADD CONSTRAINT `Company_inventoryAssetAccountId_fkey` FOREIGN KEY (`inventoryAssetAccountId`) REFERENCES `Account`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `Company_cogsAccountId_fkey` FOREIGN KEY (`cogsAccountId`) REFERENCES `Account`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `Company_openingBalanceEquityAccountId_fkey` FOREIGN KEY (`openingBalanceEquityAccountId`) REFERENCES `Account`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `Company_defaultWarehouseId_fkey` FOREIGN KEY (`defaultWarehouseId`) REFERENCES `Warehouse`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- 3) Item inventory fields
ALTER TABLE `Item`
  ADD COLUMN `trackInventory` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `valuationMethod` ENUM('WAC') NOT NULL DEFAULT 'WAC',
  ADD COLUMN `defaultWarehouseId` INTEGER NULL;

ALTER TABLE `Item`
  ADD CONSTRAINT `Item_defaultWarehouseId_fkey` FOREIGN KEY (`defaultWarehouseId`) REFERENCES `Warehouse`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- 4) StockBalance (current state)
CREATE TABLE `StockBalance` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `companyId` INTEGER NOT NULL,
  `warehouseId` INTEGER NOT NULL,
  `itemId` INTEGER NOT NULL,
  `qtyOnHand` DECIMAL(18, 2) NOT NULL,
  `avgUnitCost` DECIMAL(18, 2) NOT NULL,
  `inventoryValue` DECIMAL(18, 2) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`),
  UNIQUE INDEX `StockBalance_companyId_warehouseId_itemId_key`(`companyId`, `warehouseId`, `itemId`),
  INDEX `StockBalance_companyId_itemId_idx`(`companyId`, `itemId`),
  INDEX `StockBalance_companyId_warehouseId_idx`(`companyId`, `warehouseId`),

  CONSTRAINT `StockBalance_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `StockBalance_warehouseId_fkey` FOREIGN KEY (`warehouseId`) REFERENCES `Warehouse`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `StockBalance_itemId_fkey` FOREIGN KEY (`itemId`) REFERENCES `Item`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 5) StockMove (immutable audit trail)
CREATE TABLE `StockMove` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `companyId` INTEGER NOT NULL,
  `warehouseId` INTEGER NOT NULL,
  `itemId` INTEGER NOT NULL,
  `date` DATETIME(3) NOT NULL,
  `type` ENUM('OPENING', 'ADJUSTMENT', 'SALE_ISSUE', 'TRANSFER_OUT', 'TRANSFER_IN') NOT NULL,
  `direction` ENUM('IN', 'OUT') NOT NULL,
  `quantity` DECIMAL(18, 2) NOT NULL,
  `unitCostApplied` DECIMAL(18, 2) NOT NULL,
  `totalCostApplied` DECIMAL(18, 2) NOT NULL,
  `referenceType` VARCHAR(191) NULL,
  `referenceId` VARCHAR(191) NULL,
  `correlationId` VARCHAR(191) NULL,
  `createdByUserId` INTEGER NULL,
  `journalEntryId` INTEGER NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  INDEX `StockMove_companyId_date_idx`(`companyId`, `date`),
  INDEX `StockMove_companyId_itemId_idx`(`companyId`, `itemId`),
  INDEX `StockMove_companyId_warehouseId_idx`(`companyId`, `warehouseId`),

  CONSTRAINT `StockMove_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `StockMove_warehouseId_fkey` FOREIGN KEY (`warehouseId`) REFERENCES `Warehouse`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `StockMove_itemId_fkey` FOREIGN KEY (`itemId`) REFERENCES `Item`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

