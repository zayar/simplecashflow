-- Add Company.invoiceTemplate JSON blob (invoice design/template settings)
-- MySQL

ALTER TABLE `Company`
  ADD COLUMN `invoiceTemplate` JSON NULL;


