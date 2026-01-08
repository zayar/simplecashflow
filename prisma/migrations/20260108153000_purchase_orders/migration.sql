-- Purchase Orders (non-posting procurement documents)

CREATE TABLE `PurchaseOrder` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `companyId` INTEGER NOT NULL,
  `vendorId` INTEGER NULL,
  `warehouseId` INTEGER NOT NULL,
  `poNumber` VARCHAR(191) NOT NULL,
  `status` ENUM('DRAFT','APPROVED','CANCELLED') NOT NULL,
  `orderDate` DATETIME(3) NOT NULL,
  `expectedDate` DATETIME(3) NULL,
  `currency` VARCHAR(3) NULL,
  `total` DECIMAL(18, 2) NOT NULL,
  `notes` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  `createdByUserId` INTEGER NULL,
  `updatedByUserId` INTEGER NULL,

  PRIMARY KEY (`id`),
  UNIQUE INDEX `PurchaseOrder_companyId_poNumber_key`(`companyId`, `poNumber`),
  INDEX `PurchaseOrder_companyId_orderDate_idx`(`companyId`, `orderDate`),
  INDEX `PurchaseOrder_companyId_status_idx`(`companyId`, `status`),
  INDEX `PurchaseOrder_vendorId_fkey`(`vendorId`),
  INDEX `PurchaseOrder_warehouseId_fkey`(`warehouseId`),

  CONSTRAINT `PurchaseOrder_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `PurchaseOrder_vendorId_fkey` FOREIGN KEY (`vendorId`) REFERENCES `Vendor`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `PurchaseOrder_warehouseId_fkey` FOREIGN KEY (`warehouseId`) REFERENCES `Warehouse`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PurchaseOrderLine` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `companyId` INTEGER NOT NULL,
  `purchaseOrderId` INTEGER NOT NULL,
  `warehouseId` INTEGER NOT NULL,
  `itemId` INTEGER NOT NULL,
  `description` TEXT NULL,
  `quantity` DECIMAL(18, 2) NOT NULL,
  `unitCost` DECIMAL(18, 2) NOT NULL,
  `discountAmount` DECIMAL(18, 2) NOT NULL DEFAULT 0.00,
  `lineTotal` DECIMAL(18, 2) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`),
  INDEX `PurchaseOrderLine_companyId_idx`(`companyId`),
  INDEX `PurchaseOrderLine_purchaseOrderId_idx`(`purchaseOrderId`),
  INDEX `PurchaseOrderLine_companyId_itemId_idx`(`companyId`, `itemId`),
  INDEX `PurchaseOrderLine_itemId_fkey`(`itemId`),
  INDEX `PurchaseOrderLine_warehouseId_fkey`(`warehouseId`),

  CONSTRAINT `PurchaseOrderLine_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `PurchaseOrderLine_purchaseOrderId_fkey` FOREIGN KEY (`purchaseOrderId`) REFERENCES `PurchaseOrder`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `PurchaseOrderLine_itemId_fkey` FOREIGN KEY (`itemId`) REFERENCES `Item`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `PurchaseOrderLine_warehouseId_fkey` FOREIGN KEY (`warehouseId`) REFERENCES `Warehouse`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

