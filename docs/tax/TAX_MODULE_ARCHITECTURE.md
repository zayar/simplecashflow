# Tax Module Architecture

## System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                         FRONTEND (React/Next.js)                    │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │ /taxes      │  │ /taxes/new   │  │ /invoices/new-with-tax  │  │
│  │             │  │              │  │                          │  │
│  │ Tax List    │  │ New Tax Form │  │ Invoice + Tax Selector   │  │
│  │ - Rates     │  │ - Name       │  │ - Per-line tax dropdown │  │
│  │ - Groups    │  │ - Rate (%)   │  │ - Real-time calc        │  │
│  │ - Search    │  │ - Compound   │  │ - Subtotal/Tax/Total    │  │
│  └─────────────┘  └──────────────┘  └──────────────────────────┘  │
│         │                 │                      │                  │
│         └─────────────────┴──────────────────────┘                  │
│                           │                                         │
│                    fetchApi() from @/lib/api                       │
└───────────────────────────┼─────────────────────────────────────────┘
                            │
                    JWT Bearer Token
                            │
┌───────────────────────────┼─────────────────────────────────────────┐
│                   BACKEND (Fastify API)                             │
├───────────────────────────┼─────────────────────────────────────────┤
│                           ▼                                         │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │         Tax Routes (src/modules/taxes/taxes.routes.ts)      │   │
│  ├─────────────────────────────────────────────────────────────┤   │
│  │  GET    /companies/:id/tax-rates       → List rates        │   │
│  │  POST   /companies/:id/tax-rates       → Create rate       │   │
│  │  PUT    /companies/:id/tax-rates/:id   → Update rate       │   │
│  │  DELETE /companies/:id/tax-rates/:id   → Delete rate       │   │
│  │                                                             │   │
│  │  GET    /companies/:id/tax-groups      → List groups       │   │
│  │  POST   /companies/:id/tax-groups      → Create group      │   │
│  │  PUT    /companies/:id/tax-groups/:id  → Update group      │   │
│  │  DELETE /companies/:id/tax-groups/:id  → Delete group      │   │
│  │                                                             │   │
│  │  GET    /companies/:id/taxes           → Combined (UI)     │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                           │                                         │
│                    requireCompanyIdParam()                         │
│                    requireAnyRole()                                │
│                           │                                         │
│                           ▼                                         │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │              Tax Utilities (src/utils/tax.ts)               │   │
│  ├─────────────────────────────────────────────────────────────┤   │
│  │  calculateLineTax()      → subtotal × taxRate              │   │
│  │  calculateTaxAggregate() → sum(line taxes)                 │   │
│  │  parseTaxRate()          → "10%" → 0.10                    │   │
│  │  formatTaxRate()         → 0.10 → "10%"                    │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                           │                                         │
│                    Prisma Client                                   │
│                           │                                         │
└───────────────────────────┼─────────────────────────────────────────┘
                            │
                    SQL Queries
                            │
┌───────────────────────────┼─────────────────────────────────────────┐
│                   DATABASE (MySQL)                                  │
├───────────────────────────┼─────────────────────────────────────────┤
│                           ▼                                         │
│  ┌───────────┐   ┌───────────┐   ┌──────────────────┐            │
│  │ TaxRate   │   │ TaxGroup  │   │ TaxGroupMember   │            │
│  ├───────────┤   ├───────────┤   ├──────────────────┤            │
│  │ id        │   │ id        │   │ id               │            │
│  │ companyId │◄──┤ companyId │   │ groupId    ──────┼──┐         │
│  │ name      │   │ name      │   │ taxRateId  ──────┼──┼──┐      │
│  │ rate      │   │ totalRate │   │ createdAt        │  │  │      │
│  │ isCompound│   │ isActive  │   └──────────────────┘  │  │      │
│  │ isActive  │   │ createdAt │                         │  │      │
│  │ createdAt │   │ updatedAt │                         │  │      │
│  │ updatedAt │   └───────────┘                         │  │      │
│  └───────────┘         ▲                               │  │      │
│       ▲                │                               │  │      │
│       └────────────────┴───────────────────────────────┘  │      │
│                                                            │      │
│  ┌───────────────┐   ┌──────────────┐                    │      │
│  │ InvoiceLine   │   │ CreditNote   │                    │      │
│  │ (future)      │   │ Line         │                    │      │
│  ├───────────────┤   │ (future)     │                    │      │
│  │ taxRateId  ───┼───┘              │                    │      │
│  │ taxAmount     │                   │                    │      │
│  └───────────────┘                   └────────────────────┘      │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

---

## Data Flow: Invoice with Tax

### Step 1: User Creates Invoice (Frontend)
```
User Input:
  Item: "Service" (qty=10, price=100)
  Tax: "Myanmar [7%]" (Tax Group)

Frontend Calculation:
  subtotal = 10 × 100 = 1,000
  tax = 1,000 × 0.07 = 70
  total = 1,000 + 70 = 1,070

POST /companies/1/invoices
Body: {
  customerId: 123,
  lines: [{
    itemId: 456,
    quantity: 10,
    unitPrice: 100,
    taxRate: 0.07  // (Phase 2: add taxRateId: X, taxType: 'group')
  }]
}
```

### Step 2: Backend Creates Invoice (API)
```typescript
// books.routes.ts: POST /companies/:id/invoices
1. Validate customer belongs to company ✅
2. Validate items belong to company ✅
3. Validate currency matches baseCurrency ✅ (Critical Fix #1)
4. Compute line totals with tax:
   - lineSubtotal = qty × unitPrice
   - lineTax = lineSubtotal × taxRate
   - lineTotal = lineSubtotal + lineTax
5. Sum to get invoice totals:
   - invoice.subtotal = sum(lineSubtotal)
   - invoice.taxAmount = sum(lineTax)
   - invoice.total = subtotal + taxAmount
6. Create Invoice(status=DRAFT) in DB
```

### Step 3: User Posts Invoice (Frontend)
```
POST /companies/1/invoices/123/post
Headers: { Idempotency-Key: uuid }
```

### Step 4: Backend Posts Invoice (API)
```typescript
// books.routes.ts: POST /companies/:id/invoices/:id/post
1. Lock invoice row (FOR UPDATE) ✅
2. Verify status=DRAFT ✅
3. Recompute total from lines ✅ (Critical Fix #3)
4. Validate total matches stored total ✅
5. Apply stock moves (if tracked) ✅ (Critical Fix #2)
6. Create journal entry:
   Lines:
     Dr AR (invoice.total = 1,070)
     Cr Revenue (invoice.subtotal = 1,000)
     Cr Tax Payable (invoice.taxAmount = 70)
7. Update invoice.status = POSTED
8. Emit events → worker updates projections
```

### Step 5: Worker Updates Projections
```typescript
// worker.ts: handleJournalEntryCreated
1. Receive Pub/Sub event
2. Verify event is in outbox (authenticity) ✅
3. Load journal entry with lines
4. Update DailySummary:
   - totalIncome += 1,000 (Revenue only, excludes tax)
   - totalExpense += 0
5. Update AccountBalance (per account per day):
   - AR: debit += 1,070
   - Revenue: credit += 1,000
   - Tax Payable: credit += 70
6. Mark event as processed (idempotency)
```

---

## Tax Calculation Logic

### Simple Tax (Tax Rate)
```typescript
function calculateSimpleTax(subtotal: Decimal, rate: Decimal): Decimal {
  return subtotal.mul(rate).toDecimalPlaces(2);
}

// Example:
// subtotal = 1000, rate = 0.05 (5%)
// tax = 1000 × 0.05 = 50.00
```

### Compound Tax (Tax Group)
```typescript
function calculateCompoundTax(
  subtotal: Decimal, 
  rates: TaxRate[]
): Decimal {
  let total = new Decimal(0);
  let base = subtotal;
  
  for (const rate of rates) {
    const tax = base.mul(rate.rate).toDecimalPlaces(2);
    total = total.add(tax);
    
    if (rate.isCompound) {
      base = base.add(tax); // Tax on tax
    }
  }
  
  return total;
}

// Example (non-compound):
// subtotal = 1000
// rates = [Income 2%, Commercial 5%]
// incomeTax = 1000 × 0.02 = 20
// commercialTax = 1000 × 0.05 = 50
// total = 20 + 50 = 70

// Example (with compound):
// subtotal = 1000
// rates = [Base 10%, Compound 5% (isCompound=true)]
// baseTax = 1000 × 0.10 = 100
// compoundTax = (1000 + 100) × 0.05 = 55
// total = 100 + 55 = 155
```

### Tax Group Total Rate
```typescript
// When creating/updating TaxGroup:
totalRate = members.reduce(
  (sum, member) => sum.add(member.taxRate.rate), 
  new Decimal(0)
).toDecimalPlaces(4);

// Example:
// Myanmar Group = Income tax (2%) + Commercial (5%)
// totalRate = 0.02 + 0.05 = 0.07 (7%)
```

---

## Multi-Tenant Isolation

### Database Level
```sql
-- All tax queries include companyId
SELECT * FROM TaxRate WHERE companyId = ?;

-- Unique constraint prevents duplicate names per company
UNIQUE KEY (companyId, name)

-- Foreign key ensures referential integrity
FOREIGN KEY (companyId) REFERENCES Company(id)
```

### Application Level
```typescript
// Every route validates companyId from JWT
const companyId = requireCompanyIdParam(request, reply);

// Prisma queries always filter by companyId
await prisma.taxRate.findMany({ where: { companyId } });

// Tax groups can only reference rates from same company
const rates = await tx.taxRate.findMany({
  where: { companyId, id: { in: taxRateIds } }
});
```

---

## Integration Points

### 1. Tax → Invoice
```
Invoice creation:
  - User selects tax per line
  - Frontend stores taxRateId + taxType
  - Backend validates tax belongs to company
  - Calculates taxAmount per line
  - Sums to invoice.taxAmount

Invoice posting:
  - Recomputes tax from stored rates
  - Creates journal entry with Tax Payable
  - Updates Tax Payable account balance
```

### 2. Tax → Credit Note
```
Same as invoice, but reverses tax:
  Dr Revenue (subtotal)
  Dr Tax Payable (tax)
  Cr AR (total)
```

### 3. Tax → Reports
```
Trial Balance:
  - Tax Payable shows as LIABILITY credit balance

P&L Statement:
  - Revenue excludes tax (only subtotal)

Tax Report (future):
  - Tax collected by period
  - Tax by customer
  - Tax payable aging
```

---

## Error Handling

### Validation Errors
```typescript
// Rate out of range
if (rate < 0 || rate > 1) {
  throw new Error('rate must be between 0 and 1');
}

// Tax group with no members
if (taxRateIds.length === 0) {
  throw new Error('at least one tax rate is required');
}

// Tax rate doesn't belong to company
if (rates.length !== taxRateIds.length) {
  throw new Error('one or more tax rates not found');
}
```

### Calculation Errors
```typescript
// Rounding validation (Critical Fix #3)
const storedTotal = invoice.total;
const recomputedTotal = subtotal.add(taxAmount);
if (!recomputedTotal.equals(storedTotal)) {
  throw new Error('rounding mismatch');
}
```

---

## Performance Considerations

### Database Indexes
```sql
-- Fast lookup by company
INDEX TaxRate_companyId_idx (companyId)
INDEX TaxGroup_companyId_idx (companyId)

-- Unique constraint = fast name lookup
UNIQUE KEY (companyId, name)

-- Foreign keys for joins
INDEX TaxGroupMember_groupId_idx (groupId)
INDEX TaxGroupMember_taxRateId_idx (taxRateId)
```

### Query Optimization
```typescript
// Single query for UI dropdown (rates + groups)
GET /companies/:id/taxes

// Returns both in one response (no N+1)
{
  taxRates: [...],
  taxGroups: [...]
}

// Frontend caches in state
const [taxOptions, setTaxOptions] = useState<TaxOption[]>([]);
```

### Calculation Caching
```typescript
// Invoice line tax calculated once and stored
InvoiceLine.taxAmount = calculateLineTax(subtotal, rate);

// Invoice total tax cached
Invoice.taxAmount = sum(InvoiceLine.taxAmount);

// No recalculation needed on reads
```

---

## Compliance & Audit

### Audit Trail
```typescript
// Tax changes (future enhancement)
AuditLog {
  action: 'tax_rate.update',
  entityType: 'TaxRate',
  entityId: 123,
  metadata: {
    oldRate: 0.05,
    newRate: 0.07,
    changedBy: userId
  }
}
```

### Historical Accuracy
```
Q: What if tax rate changes after invoice is created?

A: Invoice lines store computed taxAmount (not rate ID).
   Historical invoices remain accurate even if tax rate changes.
   
Phase 2: Also store taxRateId for audit trail
         (know which tax was applied at time of sale)
```

### Tax Reports
```
Monthly Tax Summary:
  SELECT 
    SUM(taxAmount) as totalTaxCollected,
    MONTH(invoiceDate) as month
  FROM Invoice
  WHERE companyId = ? 
    AND status IN ('POSTED', 'PAID')
    AND invoiceDate BETWEEN ? AND ?
  GROUP BY MONTH(invoiceDate)
```

---

## Testing Strategy

### Unit Tests (Backend)
```typescript
describe('Tax Routes', () => {
  test('create tax rate with percentage', async () => {
    const res = await api.post('/tax-rates', { name: 'VAT', rate: 10 });
    expect(res.rate).toBe(0.10);
  });

  test('create tax group calculates total', async () => {
    const rate1 = await createTaxRate({ rate: 0.02 });
    const rate2 = await createTaxRate({ rate: 0.05 });
    const group = await api.post('/tax-groups', {
      name: 'Total',
      taxRateIds: [rate1.id, rate2.id]
    });
    expect(group.totalRate).toBe(0.07);
  });

  test('multi-tenant isolation', async () => {
    const companyA = await createCompany();
    const companyB = await createCompany();
    const taxA = await createTaxRate({ companyId: companyA.id });
    
    // Company B cannot access Company A's tax
    await expect(
      api.get(`/companies/${companyB.id}/tax-rates/${taxA.id}`)
    ).rejects.toThrow('not found');
  });
});
```

### Integration Tests (Full Flow)
```typescript
describe('Invoice with Tax', () => {
  test('invoice posting creates tax payable entry', async () => {
    // Setup
    const tax = await createTaxRate({ rate: 0.10 });
    const invoice = await createInvoice({
      lines: [{ qty: 10, price: 100, taxRateId: tax.id }]
    });
    
    // Post invoice
    await postInvoice(invoice.id);
    
    // Verify journal entry
    const je = await getJournalEntry(invoice.journalEntryId);
    const arLine = je.lines.find(l => l.account.type === 'ASSET');
    const revLine = je.lines.find(l => l.account.type === 'INCOME');
    const taxLine = je.lines.find(l => l.account.code === '2100'); // Tax Payable
    
    expect(arLine.debit).toBe(1100); // total
    expect(revLine.credit).toBe(1000); // subtotal
    expect(taxLine.credit).toBe(100); // tax
    
    // Verify trial balance
    const tb = await getTrialBalance();
    expect(tb.balanced).toBe(true);
  });
});
```

### E2E Tests (UI)
```typescript
describe('Tax Management UI', () => {
  test('create tax rate via UI', async () => {
    await page.goto('/taxes/new');
    await page.fill('[name=name]', 'VAT');
    await page.fill('[name=rate]', '10');
    await page.click('button[type=submit]');
    
    await expect(page).toHaveURL('/taxes');
    await expect(page.locator('text=VAT')).toBeVisible();
  });

  test('select tax in invoice', async () => {
    await page.goto('/invoices/new-with-tax');
    await page.selectOption('[name=itemId]', '1');
    await page.click('button:has-text("Select a Tax")');
    await page.click('button:has-text("Myanmar [7%]")');
    
    const total = await page.locator('text=/Total.*1,070/').textContent();
    expect(total).toContain('1,070');
  });
});
```

---

## Rollback Plan

### If Issues Arise

#### 1. Disable Tax UI
```bash
# Revert frontend changes
git checkout HEAD -- frontend/src/app/taxes
git checkout HEAD -- frontend/src/app/invoices/new-with-tax
git checkout HEAD -- frontend/src/app/credit-notes/new-with-tax
git checkout HEAD -- frontend/src/components/sidebar.tsx

# Users fall back to /invoices/new (no tax)
```

#### 2. Rollback Database
```bash
# Find migration
ls prisma/migrations/ | grep tax_module

# Rollback (WARNING: data loss)
npx prisma migrate resolve --rolled-back <migration-name>

# Drop tables manually if needed
mysql -u root -p -e "
  DROP TABLE TaxGroupMember;
  DROP TABLE TaxGroup;
  DROP TABLE TaxRate;
"
```

#### 3. Revert Backend
```bash
git checkout HEAD -- src/modules/taxes
git checkout HEAD -- src/utils/tax.ts
git checkout HEAD -- src/index.ts

# Rebuild
npm run build
```

---

## Monitoring & Alerts

### Key Metrics
```
- Tax rates created (daily)
- Tax groups created (daily)
- Invoices with tax (% of total invoices)
- Tax Payable account balance (trending up = good)
- Rounding errors (should be 0)
- Trial balance mismatches (alert if > 0)
```

### Logging
```typescript
// Add to tax routes
fastify.log.info({
  companyId,
  taxRateId,
  action: 'tax_rate.create',
  rate: ratePercent
}, 'Tax rate created');
```

### Health Checks
```bash
# Verify tax tables exist
mysql -e "SHOW TABLES LIKE 'Tax%';"

# Count taxes per company
mysql -e "
  SELECT companyId, COUNT(*) as tax_count
  FROM TaxRate
  GROUP BY companyId;
"

# Verify trial balance
curl /companies/1/reports/trial-balance | jq .balanced
# Should return: true
```

---

## Success Metrics

### Before Launch
- [x] Tax CRUD works (all endpoints)
- [x] UI matches screenshots
- [x] Tax calculations are accurate
- [x] Multi-tenant isolation works
- [x] RBAC enforcement works

### After Launch (Week 1)
- [ ] 100% uptime
- [ ] 0 tax calculation errors
- [ ] 0 trial balance mismatches
- [ ] >50% invoices use tax feature
- [ ] User feedback positive

### After Launch (Month 1)
- [ ] Tax reports implemented
- [ ] Tax payment tracking added
- [ ] Tax reconciliation working
- [ ] User training complete

---

## 🎓 User Training Materials

### Quick Start Guide
```
1. Create Tax Rates:
   - Go to Accounting → Taxes
   - Click "New Tax"
   - Enter name (e.g., "VAT") and rate (e.g., "10")
   - Click Save

2. Create Tax Groups (optional):
   - Use API or admin UI
   - Combine multiple taxes (e.g., "Myanmar" = Income + Commercial)

3. Use Tax in Invoice:
   - Go to Invoices → New Invoice (with tax)
   - Add items as usual
   - For each line, click "Select a Tax"
   - Choose tax rate or group
   - Totals auto-calculate
   - Save and post as normal

4. Reports:
   - Tax appears on Trial Balance (Tax Payable account)
   - Revenue in P&L excludes tax
   - Balance Sheet shows Tax Payable as LIABILITY
```

### FAQ
```
Q: Can I change a tax rate after creating invoices?
A: Yes, but it won't affect old invoices (they store computed tax amounts).

Q: What's the difference between tax rate and tax group?
A: Tax rate is single (e.g., "VAT 10%"). Tax group combines multiple rates (e.g., "Total Tax" = VAT + Sales Tax).

Q: Is tax included in revenue?
A: No. Revenue = subtotal (before tax). Tax goes to Tax Payable account.

Q: Can I have different taxes per item?
A: Yes! Each invoice line can have its own tax rate/group.

Q: What happens if I delete a tax rate?
A: Future: Will be blocked if used in any invoices. Currently: allowed (not recommended).
```

---

## 📞 Support

### Documentation
- **Implementation:** `TAX_MODULE_IMPLEMENTATION_GUIDE.md`
- **Critical Fixes:** `CRITICAL_FIXES_SUMMARY.md`
- **Migration:** `CRITICAL_FIX_5_TAX_MIGRATION.md`
- **Architecture:** `TAX_MODULE_ARCHITECTURE.md` (this file)
- **Deployment:** `DEPLOY_TAX_MODULE.sh`

### Code References
- **Backend API:** `src/modules/taxes/taxes.routes.ts`
- **Tax Utils:** `src/utils/tax.ts`
- **Invoice Integration:** `src/modules/books/books.routes.ts:601-730`
- **Frontend Tax List:** `frontend/src/app/taxes/page.tsx`
- **Frontend Invoice:** `frontend/src/app/invoices/new-with-tax/page.tsx`

---

**Status:** Tax module fully implemented and ready for deployment! 🎉

