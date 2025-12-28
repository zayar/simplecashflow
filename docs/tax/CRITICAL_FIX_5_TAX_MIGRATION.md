# CRITICAL FIX #5: Tax Handling System - Database Migration Guide

## Overview
This document describes the database schema changes required to implement the tax handling system.

## Required Schema Changes

### 1. Add `taxPayableAccountId` to Company table

```prisma
model Company {
  // ... existing fields ...
  
  // Tax configuration (CRITICAL FIX #5)
  taxPayableAccountId Int?
  taxPayableAccount   Account? @relation("Company_TaxPayable", fields: [taxPayableAccountId], references: [id])
}
```

### 2. Update Account model to support tax payable relation

```prisma
model Account {
  // ... existing fields ...
  
  // Tax relation (CRITICAL FIX #5)
  taxPayableFor Company[] @relation("Company_TaxPayable")
}
```

### 3. Add `taxAmount` to InvoiceLine table

The `InvoiceLine.taxRate` column already exists but is never used. Add `taxAmount`:

```prisma
model InvoiceLine {
  // ... existing fields ...
  
  taxRate     Decimal? @db.Decimal(5, 4)  // e.g., 0.1000 for 10%
  taxAmount   Decimal? @db.Decimal(18, 2) // CRITICAL FIX #5: computed tax for this line
}
```

### 4. Add tax fields to Invoice table

```prisma
model Invoice {
  // ... existing fields ...
  
  subtotal    Decimal @db.Decimal(18, 2) @default(0) // CRITICAL FIX #5: total before tax
  taxAmount   Decimal @db.Decimal(18, 2) @default(0) // CRITICAL FIX #5: total tax
  // total field remains as grand total (subtotal + taxAmount)
}
```

### 5. Similar changes for PurchaseBill

```prisma
model PurchaseBill {
  // ... existing fields ...
  
  subtotal    Decimal @db.Decimal(18, 2) @default(0) // total before tax
  taxAmount   Decimal @db.Decimal(18, 2) @default(0) // total tax
  // total remains as grand total
}

model PurchaseBillLine {
  // ... existing fields ...
  
  taxRate     Decimal? @db.Decimal(5, 4)
  taxAmount   Decimal? @db.Decimal(18, 2)
}
```

### 6. Create Tax Payable account during registration

Update `src/modules/auth/auth.routes.ts` to create a Tax Payable account:

```typescript
// Add to DEFAULT_ACCOUNTS in company.constants.ts:
{
  code: '2100',
  name: 'Tax Payable',
  type: AccountType.LIABILITY,
  normalBalance: NormalBalance.CREDIT,
  reportGroup: AccountReportGroup.OTHER_CURRENT_LIABILITY,
  cashflowActivity: CashflowActivity.OPERATING,
}
```

## Migration Steps

### Step 1: Generate Prisma Migration

```bash
npx prisma migrate dev --name add_tax_handling_system
```

### Step 2: Run Data Migration (if needed)

For existing invoices without tax:

```sql
-- Set subtotal = total (no tax applied yet)
UPDATE Invoice SET subtotal = total, taxAmount = 0 WHERE subtotal IS NULL OR subtotal = 0;

-- Set line tax amounts to 0 for existing lines
UPDATE InvoiceLine SET taxAmount = 0 WHERE taxAmount IS NULL;

-- Same for purchase bills
UPDATE PurchaseBill SET subtotal = total, taxAmount = 0 WHERE subtotal IS NULL OR subtotal = 0;
UPDATE PurchaseBillLine SET taxAmount = 0 WHERE taxAmount IS NULL;
```

### Step 3: Create Tax Payable accounts for existing companies

```typescript
// Run this migration script once:
import { prisma } from './src/infrastructure/db.js';
import { AccountType, NormalBalance, AccountReportGroup, CashflowActivity } from '@prisma/client';

async function migrateTaxAccounts() {
  const companies = await prisma.company.findMany({ where: { taxPayableAccountId: null } });
  
  for (const company of companies) {
    // Check if Tax Payable account already exists
    let taxAccount = await prisma.account.findFirst({
      where: { companyId: company.id, type: 'LIABILITY', code: '2100' },
    });
    
    if (!taxAccount) {
      taxAccount = await prisma.account.create({
        data: {
          companyId: company.id,
          code: '2100',
          name: 'Tax Payable',
          type: AccountType.LIABILITY,
          normalBalance: NormalBalance.CREDIT,
          reportGroup: AccountReportGroup.OTHER_CURRENT_LIABILITY,
          cashflowActivity: CashflowActivity.OPERATING,
        },
      });
    }
    
    await prisma.company.update({
      where: { id: company.id },
      data: { taxPayableAccountId: taxAccount.id },
    });
  }
  
  console.log(`Migrated ${companies.length} companies`);
}

migrateTaxAccounts().catch(console.error);
```

## Testing Checklist

After migration:

- [ ] Create a new invoice with tax (taxRate: 0.10 on a line)
- [ ] Verify `InvoiceLine.taxAmount` is computed correctly
- [ ] Verify `Invoice.subtotal` + `Invoice.taxAmount` = `Invoice.total`
- [ ] Post the invoice and verify journal entry has 3 lines:
  - Dr AR (total)
  - Cr Revenue (subtotal)
  - Cr Tax Payable (taxAmount)
- [ ] Verify trial balance is still balanced after tax entries
- [ ] Test purchase bill with tax
- [ ] Test credit note with tax (reverses tax)

## Rollback Plan

If issues arise:

```sql
-- Remove tax fields (data loss!)
ALTER TABLE Invoice DROP COLUMN subtotal;
ALTER TABLE Invoice DROP COLUMN taxAmount;
ALTER TABLE InvoiceLine DROP COLUMN taxAmount;
ALTER TABLE PurchaseBill DROP COLUMN subtotal;
ALTER TABLE PurchaseBill DROP COLUMN taxAmount;
ALTER TABLE PurchaseBillLine DROP COLUMN taxAmount;
ALTER TABLE Company DROP COLUMN taxPayableAccountId;
```

## Future Enhancements

- [ ] Add `TaxJurisdiction` table for multi-state/country tax
- [ ] Add `TaxExemption` table for exempt customers
- [ ] Add tax reports (monthly VAT return)
- [ ] Add compound tax support (tax on tax)
- [ ] Add tax groups (multiple taxes per line)

