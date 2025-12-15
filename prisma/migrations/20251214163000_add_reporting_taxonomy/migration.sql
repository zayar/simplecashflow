-- Reporting v1 taxonomy for Accounts
-- - normalBalance: DEBIT/CREDIT (derived from AccountType)
-- - reportGroup: optional classification for reporting
-- - cashflowActivity: optional mapping for Cashflow statement (later)

ALTER TABLE `Account`
  ADD COLUMN `normalBalance` ENUM('DEBIT','CREDIT') NOT NULL DEFAULT 'DEBIT',
  ADD COLUMN `reportGroup` ENUM(
    'CASH_AND_CASH_EQUIVALENTS',
    'ACCOUNTS_RECEIVABLE',
    'INVENTORY',
    'OTHER_CURRENT_ASSET',
    'FIXED_ASSET',
    'ACCOUNTS_PAYABLE',
    'OTHER_CURRENT_LIABILITY',
    'LONG_TERM_LIABILITY',
    'EQUITY',
    'SALES_REVENUE',
    'OTHER_INCOME',
    'COGS',
    'OPERATING_EXPENSE',
    'OTHER_EXPENSE',
    'TAX_EXPENSE'
  ) NULL,
  ADD COLUMN `cashflowActivity` ENUM('OPERATING','INVESTING','FINANCING') NULL;

-- Backfill normal balance from account type
UPDATE `Account`
SET `normalBalance` = CASE
  WHEN `type` IN ('ASSET','EXPENSE') THEN 'DEBIT'
  WHEN `type` IN ('LIABILITY','EQUITY','INCOME') THEN 'CREDIT'
  ELSE 'DEBIT'
END;

-- Best-effort default report groups for the default chart of accounts.
-- (Safe: only applies when codes exist; can be customized later.)
UPDATE `Account`
SET `reportGroup` = 'CASH_AND_CASH_EQUIVALENTS',
    `cashflowActivity` = 'OPERATING'
WHERE `type` = 'ASSET' AND `code` IN ('1000','1010');

UPDATE `Account`
SET `reportGroup` = 'ACCOUNTS_RECEIVABLE',
    `cashflowActivity` = 'OPERATING'
WHERE `type` = 'ASSET' AND `code` = '1200';

UPDATE `Account`
SET `reportGroup` = 'ACCOUNTS_PAYABLE',
    `cashflowActivity` = 'OPERATING'
WHERE `type` = 'LIABILITY' AND `code` = '2000';

UPDATE `Account`
SET `reportGroup` = 'EQUITY',
    `cashflowActivity` = 'FINANCING'
WHERE `type` = 'EQUITY' AND `code` = '3000';

UPDATE `Account`
SET `reportGroup` = 'SALES_REVENUE',
    `cashflowActivity` = 'OPERATING'
WHERE `type` = 'INCOME' AND `code` = '4000';

UPDATE `Account`
SET `reportGroup` = 'OPERATING_EXPENSE',
    `cashflowActivity` = 'OPERATING'
WHERE `type` = 'EXPENSE' AND `code` = '5000';

