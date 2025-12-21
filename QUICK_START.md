# 🚀 Quick Start - Tax Module

## One-Command Deployment

```bash
./DEPLOY_TAX_MODULE.sh
```

That's it! The script handles everything automatically.

---

## Manual Deployment (5 Steps)

### 1. Run Database Migration
```bash
npx prisma migrate dev --name add_tax_module
```
Creates TaxRate, TaxGroup, TaxGroupMember tables.

### 2. Seed Default Taxes
```bash
npx ts-node scripts/seed_tax_defaults.ts
```
Creates Income tax (2%), Commercial (5%), Myanmar (7%) for all companies.

### 3. Build
```bash
npm run build
cd frontend && npm run build
```

### 4. Restart Services
```bash
npm run dev  # Backend
cd frontend && npm run dev  # Frontend
```

### 5. Test It!
```
Open: http://localhost:3000/taxes
Click: "New Tax"
Create: VAT 10%
Done! ✅
```

---

## 📱 UI Pages Created

| Page | URL | Description |
|------|-----|-------------|
| Tax List | `/taxes` | View all taxes (rates + groups) |
| New Tax | `/taxes/new` | Create tax rate |
| Invoice + Tax | `/invoices/new-with-tax` | Invoice with tax dropdown |
| Credit Note + Tax | `/credit-notes/new-with-tax` | Credit note with tax |

---

## 🎯 Quick Test

### Create Your First Tax
1. Go to http://localhost:3000/taxes
2. Click "New Tax"
3. Name: "Sales Tax"
4. Rate: "10"
5. Click "Save"
6. ✅ Done!

### Use Tax in Invoice
1. Go to http://localhost:3000/invoices/new-with-tax
2. Select customer and item
3. Click tax dropdown on line
4. Select "Sales Tax [10%]"
5. See totals auto-calculate
6. ✅ Done!

---

## 📊 What You Get

### Tax Management
- ✅ Create tax rates (e.g., VAT 10%)
- ✅ Create tax groups (e.g., Myanmar = Income 2% + Commercial 5%)
- ✅ Search and filter
- ✅ Edit and delete

### Invoice with Tax
- ✅ Per-line tax selection
- ✅ Search dropdown
- ✅ Real-time calculation
- ✅ Subtotal + Tax = Total

### Accounting
- ✅ Revenue = subtotal (excludes tax)
- ✅ Tax posts to Tax Payable (LIABILITY)
- ✅ Trial balance stays balanced
- ✅ All critical fixes applied

---

## 🆘 Troubleshooting

### "Table TaxRate doesn't exist"
➜ Run: `npx prisma migrate dev`

### "Tax dropdown is empty"
➜ Run: `npx ts-node scripts/seed_tax_defaults.ts`

### "Cannot access /taxes (403)"
➜ Login as OWNER or ACCOUNTANT role

### "Totals don't match"
➜ Check tax rate is 0-100% (not 0-1)

---

## 📚 Full Documentation

- `TAX_MODULE_IMPLEMENTATION_GUIDE.md` - Complete guide
- `TAX_MODULE_ARCHITECTURE.md` - System architecture
- `CRITICAL_FIXES_SUMMARY.md` - All 5 fixes explained
- `DEPLOYMENT_CHECKLIST.md` - Step-by-step deployment

---

## ✨ You're Ready!

**Status:** 100% Complete ✅

**Next:** Run `./DEPLOY_TAX_MODULE.sh`

**Happy Accounting! 📊**
