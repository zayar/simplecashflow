-- Add tax/subtotal to Purchase Bills and Vendor Credits

-- PurchaseBill: store subtotal + tax amount (header)
ALTER TABLE `PurchaseBill`
  ADD COLUMN `subtotal` DECIMAL(18,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN `taxAmount` DECIMAL(18,2) NOT NULL DEFAULT 0.00;

-- PurchaseBillLine: store tax rate + tax amount (line)
ALTER TABLE `PurchaseBillLine`
  ADD COLUMN `taxRate` DECIMAL(5,4) NULL,
  ADD COLUMN `taxAmount` DECIMAL(18,2) NOT NULL DEFAULT 0.00;

-- VendorCredit: store subtotal + tax amount (header)
ALTER TABLE `VendorCredit`
  ADD COLUMN `subtotal` DECIMAL(18,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN `taxAmount` DECIMAL(18,2) NOT NULL DEFAULT 0.00;

-- VendorCreditLine: store discount + tax (line)
ALTER TABLE `VendorCreditLine`
  ADD COLUMN `discountAmount` DECIMAL(18,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN `taxRate` DECIMAL(5,4) NULL,
  ADD COLUMN `taxAmount` DECIMAL(18,2) NOT NULL DEFAULT 0.00;

