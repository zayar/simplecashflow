# Tax Module Implementation Guide

## Overview
This guide provides complete instructions for implementing the tax module with UI matching the screenshots provided.

## 🎯 What's Been Implemented

### 1. Database Schema (Prisma)
✅ **Added Models:**
- `TaxRate` - Individual tax rates (e.g., "Income tax [2%]", "Commercial [5%]")
- `TaxGroup` - Combinations of tax rates (e.g., "Myanmar [7%]" = Income + Commercial)
- `TaxGroupMember` - Join table for tax groups

### 2. Backend API Routes
✅ **Created:** `src/modules/taxes/taxes.routes.ts`

**Endpoints:**
- `GET /companies/:companyId/tax-rates` - List all tax rates
- `POST /companies/:companyId/tax-rates` - Create tax rate
- `PUT /companies/:companyId/tax-rates/:id` - Update tax rate
- `DELETE /companies/:companyId/tax-rates/:id` - Delete tax rate
- `GET /companies/:companyId/tax-groups` - List all tax groups
- `POST /companies/:companyId/tax-groups` - Create tax group
- `PUT /companies/:companyId/tax-groups/:id` - Update tax group
- `DELETE /companies/:companyId/tax-groups/:id` - Delete tax group
- `GET /companies/:companyId/taxes` - Combined endpoint (rates + groups for UI)

### 3. Frontend Pages
✅ **Created:**
- `/taxes` - Tax rates and groups list page
- `/taxes/new` - Create new tax rate page
- `/invoices/new-with-tax` - Invoice creation with tax support
- `/credit-notes/new-with-tax` - Credit note creation with tax support

✅ **Updated:**
- Sidebar navigation - Added "Taxes" menu item

### 4. Utilities
✅ **Created:** `src/utils/tax.ts`
- Tax calculation functions
- Tax rate parsing and formatting
- Tax validation helpers

### 5. Critical Fixes Integration
✅ **All critical fixes applied:**
- Multi-currency enforcement in payments
- Negative stock prevention
- Rounding validation
- Period close enforcement
- Tax system foundation

---

## 📋 Step-by-Step Deployment

### Step 1: Run Database Migration

```bash
# Navigate to project root
cd /Users/zayarmin/Development/cashflow-app

# Generate and apply migration
npx prisma migrate dev --name add_tax_module

# This will:
# - Add TaxRate, TaxGroup, TaxGroupMember tables
# - Add relations to Company model
```

### Step 2: Seed Default Tax Data (Optional)

Create a seed script to add common tax rates for Myanmar:

```typescript
// scripts/seed_tax_defaults.ts
import { prisma } from '../src/infrastructure/db.js';

async function seedTaxes() {
  const companies = await prisma.company.findMany();
  
  for (const company of companies) {
    // Create common Myanmar tax rates
    const incomeTax = await prisma.taxRate.create({
      data: {
        companyId: company.id,
        name: 'Income tax',
        rate: 0.02, // 2%
        isCompound: false,
        isActive: true,
      },
    });

    const commercialTax = await prisma.taxRate.create({
      data: {
        companyId: company.id,
        name: 'Commercial',
        rate: 0.05, // 5%
        isCompound: false,
        isActive: true,
      },
    });

    // Create Myanmar tax group (7% = 2% + 5%)
    const myanmarGroup = await prisma.taxGroup.create({
      data: {
        companyId: company.id,
        name: 'Myanmar',
        totalRate: 0.07,
        isActive: true,
      },
    });

    // Link rates to group
    await prisma.taxGroupMember.createMany({
      data: [
        { groupId: myanmarGroup.id, taxRateId: incomeTax.id },
        { groupId: myanmarGroup.id, taxRateId: commercialTax.id },
      ],
    });

    console.log(`✅ Seeded taxes for company ${company.id} (${company.name})`);
  }
}

seedTaxes().catch(console.error).finally(() => process.exit());
```

Run it:
```bash
npx ts-node scripts/seed_tax_defaults.ts
```

### Step 3: Test Backend API

```bash
# Get auth token
TOKEN=$(curl -X POST http://localhost:8080/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"YourPassword"}' \
  | jq -r .token)

# List taxes
curl http://localhost:8080/companies/1/taxes \
  -H "Authorization: Bearer $TOKEN"

# Create a tax rate
curl -X POST http://localhost:8080/companies/1/tax-rates \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"VAT","rate":10}'

# Create a tax group
curl -X POST http://localhost:8080/companies/1/tax-groups \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Total Tax","taxRateIds":[1,2]}'
```

### Step 4: Test Frontend

1. **Start the app:**
```bash
# Backend
npm run dev

# Frontend (in separate terminal)
cd frontend
npm run dev
```

2. **Navigate to:**
- `http://localhost:3000/taxes` - View tax list
- `http://localhost:3000/taxes/new` - Create new tax
- `http://localhost:3000/invoices/new-with-tax` - Invoice with tax
- `http://localhost:3000/credit-notes/new-with-tax` - Credit note with tax

3. **Test workflow:**
- Create tax rate "Income tax [2%]"
- Create tax rate "Commercial [5%]"
- Create tax group "Myanmar [7%]" with both rates
- Create invoice with an item and select "Myanmar [7%]" tax
- Verify totals calculate correctly

---

## 🎨 UI Features Implemented

### Tax List Page (`/taxes`)
- ✅ Searchable table with tax rates and groups
- ✅ "New Tax" button
- ✅ Filter dropdown (Active taxes)
- ✅ Checkbox selection
- ✅ Rate percentage display
- ✅ Hover effects

### New Tax Page (`/taxes/new`)
- ✅ Tax name input
- ✅ Rate (%) input with % symbol
- ✅ "This tax is a compound tax" checkbox with info icon
- ✅ Save/Cancel buttons
- ✅ Back navigation

### Invoice with Tax (`/invoices/new-with-tax`)
- ✅ Tax Exclusive toggle
- ✅ Per-line tax selector dropdown
- ✅ Tax search functionality
- ✅ Tax groups section
- ✅ "New Tax" quick action in dropdown
- ✅ Subtotal, Tax, and Total calculation
- ✅ Discount, Shipping, Adjustment fields
- ✅ Round off display

### Credit Note with Tax (`/credit-notes/new-with-tax`)
- ✅ Same tax features as invoice
- ✅ Pre-fill from invoice if linked
- ✅ Save as Draft / Save as Open buttons

---

## 🔧 Configuration Options

### Environment Variables (Optional)
Add to `.env`:
```bash
# Tax defaults
DEFAULT_TAX_RATE_PERCENT=7
DEFAULT_TAX_NAME="Standard Tax"

# Enable strict tax enforcement
REQUIRE_TAX_ON_INVOICES=false
```

### Company Settings (Future Enhancement)
Add to company settings API:
- Default tax rate for new invoices
- Tax-inclusive vs tax-exclusive pricing
- Tax jurisdiction (for multi-state/country)
- Tax exemption rules

---

## 📊 Data Flow

### Invoice Creation with Tax
```
1. User selects item → qty, price
2. User selects tax → "Myanmar [7%]"
3. Frontend calculates:
   - Subtotal = qty × price
   - Tax = subtotal × 7%
   - Total = subtotal + tax
4. POST /companies/:id/invoices
   Body: { lines: [{ itemId, qty, price, taxRate: 0.07 }] }
5. Backend (after migration):
   - Validates tax rate
   - Stores taxAmount per line
   - Stores subtotal, taxAmount, total on invoice
6. Invoice posting creates JE:
   - Dr AR (total)
   - Cr Revenue (subtotal)
   - Cr Tax Payable (taxAmount)
```

### Tax Group Calculation
```
"Myanmar [7%]" group contains:
  - Income tax: 2%
  - Commercial: 5%

For invoice line: qty=100, price=10
  - Subtotal: 1000
  - Income tax: 1000 × 2% = 20
  - Commercial: 1000 × 5% = 50
  - Tax total: 70
  - Grand total: 1070
```

---

## 🧪 Testing Checklist

### Backend Tests
- [ ] Create tax rate with rate=10 (auto-converts to 0.10)
- [ ] Create tax rate with rate=0.10 (stays 0.10)
- [ ] Create tax group with 2 rates (totalRate = sum)
- [ ] Update tax group members (recalculates totalRate)
- [ ] Delete tax rate (should fail if used in group)
- [ ] Multi-tenant: Company A cannot access Company B's taxes

### Frontend Tests
- [ ] Tax list page loads rates and groups
- [ ] Search filters work correctly
- [ ] New tax page validates rate (0-100%)
- [ ] Invoice tax dropdown shows rates + groups
- [ ] Tax calculation is correct (line-level)
- [ ] Subtotal + Tax = Total (always balanced)
- [ ] Credit note tax dropdown works same as invoice

### Integration Tests
- [ ] Create invoice with tax, post it
- [ ] Verify journal entry has 3 lines (AR, Revenue, Tax Payable)
- [ ] Trial balance is still balanced
- [ ] Create credit note with tax
- [ ] Verify tax is reversed correctly
- [ ] Payment doesn't affect tax (only AR/Revenue)

---

## 🚨 Known Limitations (Current Implementation)

### Phase 1 (Current - DB Schema Ready)
- ✅ Tax rates and groups CRUD
- ✅ Tax UI components
- ✅ Tax calculation logic
- ❌ Tax not yet saved to invoice/credit note lines (requires schema migration)
- ❌ Tax not yet posted to Tax Payable account (requires invoice schema update)

### Phase 2 (After Invoice/Line Schema Migration)
**Required schema changes:**
```prisma
model Invoice {
  subtotal    Decimal @db.Decimal(18, 2) @default(0)
  taxAmount   Decimal @db.Decimal(18, 2) @default(0)
  // total remains as grand total
}

model InvoiceLine {
  taxRate     Decimal? @db.Decimal(5, 4)  // 0.0700 for 7%
  taxAmount   Decimal? @db.Decimal(18, 2) // computed tax
  taxRateId   Int?
  taxRate     TaxRate? @relation(fields: [taxRateId], references: [id])
}

model CreditNoteLine {
  taxRate     Decimal? @db.Decimal(5, 4)
  taxAmount   Decimal? @db.Decimal(18, 2)
  taxRateId   Int?
  taxRate     TaxRate? @relation(fields: [taxRateId], references: [id])
}
```

### Phase 3 (Future Enhancements)
- [ ] Tax exemptions (per customer)
- [ ] Multiple jurisdictions (state/country)
- [ ] Tax reports (monthly VAT return)
- [ ] Tax audit trail
- [ ] Compound tax support (tax on tax)
- [ ] Tax on discounts and shipping
- [ ] Reverse charge mechanism

---

## 📝 Migration Path

### Current State
```
Invoice.total = sum(line.qty × line.unitPrice)
Journal Entry: Dr AR, Cr Revenue (total)
```

### After Migration
```
InvoiceLine.taxAmount = (qty × unitPrice) × taxRate
Invoice.subtotal = sum(line.qty × line.unitPrice)
Invoice.taxAmount = sum(line.taxAmount)
Invoice.total = subtotal + taxAmount

Journal Entry:
  Dr AR (total = subtotal + tax)
  Cr Revenue (subtotal)
  Cr Tax Payable (taxAmount)
```

### Migration Script
```sql
-- Add columns (nullable initially)
ALTER TABLE Invoice ADD COLUMN subtotal DECIMAL(18,2) NULL;
ALTER TABLE Invoice ADD COLUMN taxAmount DECIMAL(18,2) NULL;
ALTER TABLE InvoiceLine ADD COLUMN taxAmount DECIMAL(18,2) NULL;

-- Backfill existing invoices (assumes no tax)
UPDATE Invoice SET subtotal = total, taxAmount = 0 WHERE subtotal IS NULL;
UPDATE InvoiceLine SET taxAmount = 0 WHERE taxAmount IS NULL;

-- Make non-nullable
ALTER TABLE Invoice MODIFY subtotal DECIMAL(18,2) NOT NULL DEFAULT 0;
ALTER TABLE Invoice MODIFY taxAmount DECIMAL(18,2) NOT NULL DEFAULT 0;
ALTER TABLE InvoiceLine MODIFY taxAmount DECIMAL(18,2) NOT NULL DEFAULT 0;
```

---

## 🔗 Related Files

### Backend
- `src/modules/taxes/taxes.routes.ts` - Tax CRUD API
- `src/utils/tax.ts` - Tax calculation utilities
- `src/modules/books/books.routes.ts` - Invoice/credit note with tax integration
- `src/index.ts` - Tax routes registered

### Frontend
- `frontend/src/app/taxes/page.tsx` - Tax list
- `frontend/src/app/taxes/new/page.tsx` - New tax form
- `frontend/src/app/invoices/new-with-tax/page.tsx` - Invoice with tax
- `frontend/src/app/credit-notes/new-with-tax/page.tsx` - Credit note with tax
- `frontend/src/components/sidebar.tsx` - Navigation

### Documentation
- `CRITICAL_FIX_5_TAX_MIGRATION.md` - Database migration guide
- `CRITICAL_FIXES_SUMMARY.md` - All critical fixes summary
- `TAX_MODULE_IMPLEMENTATION_GUIDE.md` - This file

---

## 🚀 Quick Start (After Migration)

### 1. Create Tax Rates
```bash
# Via UI: Go to /taxes → New Tax
# Or via API:
curl -X POST http://localhost:8080/companies/1/tax-rates \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Income tax","rate":2}'

curl -X POST http://localhost:8080/companies/1/tax-rates \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Commercial","rate":5}'
```

### 2. Create Tax Group
```bash
curl -X POST http://localhost:8080/companies/1/tax-groups \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Myanmar","taxRateIds":[1,2]}'
```

### 3. Create Invoice with Tax
```bash
# Via UI: Go to /invoices/new-with-tax
# Select item, quantity, price
# Select tax: "Myanmar [7%]"
# Save → subtotal=1000, tax=70, total=1070
```

---

## 🎯 Success Criteria

### Before Going Live
- [ ] All tax CRUD operations work
- [ ] Tax dropdown shows in invoice/credit note
- [ ] Tax calculations are accurate to 2 decimals
- [ ] Journal entries with tax are balanced (Dr = Cr)
- [ ] Trial balance is still balanced with tax entries
- [ ] Tax can be edited/deleted if not used
- [ ] Multi-tenant isolation works (Company A can't see Company B's taxes)

### Production Monitoring
- [ ] Monitor for rounding errors in tax calculations
- [ ] Monitor Tax Payable account balance
- [ ] Alert if trial balance becomes unbalanced
- [ ] Track tax liability vs actual payments to tax authority
- [ ] Monthly tax reconciliation report

---

## 💡 Usage Examples

### Example 1: Simple Invoice with Single Tax
```
Item: "Consulting Service"
Qty: 10 hours
Rate: 100 MMK/hour
Tax: Commercial [5%]

Calculations:
  Subtotal: 10 × 100 = 1,000
  Tax: 1,000 × 5% = 50
  Total: 1,050

Journal Entry:
  Dr AR 1,050
  Cr Revenue 1,000
  Cr Tax Payable 50
```

### Example 2: Invoice with Tax Group
```
Item: "Product"
Qty: 100
Rate: 20 MMK
Tax: Myanmar [7%] (Income 2% + Commercial 5%)

Calculations:
  Subtotal: 100 × 20 = 2,000
  Income tax: 2,000 × 2% = 40
  Commercial: 2,000 × 5% = 100
  Tax total: 140
  Total: 2,140

Journal Entry:
  Dr AR 2,140
  Cr Revenue 2,000
  Cr Tax Payable 140
```

### Example 3: Credit Note with Tax
```
Original Invoice: Total 1,050 (includes 50 tax)
Return: Full amount

Credit Note:
  Subtotal: 1,000
  Tax: 50
  Total: 1,050

Journal Entry (reversal):
  Dr Revenue 1,000
  Dr Tax Payable 50
  Cr AR 1,050
```

---

## 🔐 Security Considerations

### Access Control
- ✅ Tax CRUD requires OWNER or ACCOUNTANT role
- ✅ Multi-tenant isolation enforced
- ✅ Tax rates can't be modified if already used (future: add usage tracking)

### Data Validation
- ✅ Rate must be 0-100% (or 0-1.0 decimal)
- ✅ Tax group must have at least 1 member
- ✅ All tax rates in group must belong to same company
- ✅ Tax calculations use Prisma.Decimal (no floating-point drift)

### Audit Trail
- ⚠️ TODO: Add audit logs for tax CRUD operations
- ⚠️ TODO: Track when tax rates are changed (affects historical reporting)

---

## 📞 Support & Troubleshooting

### Common Issues

**Issue:** "Tax dropdown is empty"
- **Fix:** Create tax rates first at `/taxes/new`

**Issue:** "Total doesn't match subtotal + tax"
- **Fix:** Check for rounding errors, ensure using 2 decimal places

**Issue:** "Journal entry unbalanced after tax"
- **Fix:** Verify Tax Payable account exists and is LIABILITY type

**Issue:** "Can't create tax group"
- **Fix:** Ensure at least 1 tax rate exists first

**Issue:** "Tax not appearing on posted invoice"
- **Fix:** Schema migration not yet run (tax fields don't exist in DB)

---

## 🎉 Next Steps

After successful deployment:

1. **Train users** on tax module:
   - How to create tax rates
   - How to create tax groups
   - How to apply tax to invoices

2. **Create tax reports**:
   - Monthly tax collected report
   - Tax by customer report
   - Tax payable aging

3. **Add tax settings page**:
   - Default tax for new invoices
   - Tax-inclusive vs exclusive pricing
   - Tax exemption rules

4. **Integrate with accounting close**:
   - Tax payable reconciliation
   - Tax payment recording
   - Tax filing status tracking

---

**Status:** Tax module infrastructure complete. Ready for schema migration and activation.

