-- Add line-level discount support for invoices and credit notes

ALTER TABLE `InvoiceLine`
  ADD COLUMN `discountAmount` DECIMAL(18,2) NOT NULL DEFAULT 0;

ALTER TABLE `CreditNoteLine`
  ADD COLUMN `discountAmount` DECIMAL(18,2) NOT NULL DEFAULT 0;


