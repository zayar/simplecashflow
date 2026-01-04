# Pitix ↔ Cashflow Integration Package

**Version:** 1.0.0  
**Last Updated:** January 2026

---

## Overview

This package contains everything the Pitix team needs to integrate with Cashflow's finance API.

When a sale is completed in Pitix POS, it will automatically create an invoice in Cashflow for financial tracking and reporting.

---

## Package Contents

```
piti-integration/
├── README.md                    # This file
├── INTEGRATION_GUIDE.md         # Step-by-step setup guide
├── API_REFERENCE.md             # Complete API documentation
├── cashflow_client.ts           # TypeScript client (copy to Pitix)
└── cashflow_sale_helper.ts      # Integration helper example
```

---

## Quick Start (5 Minutes)

### 1. Get Your Credentials

Contact Cashflow team for:
- `CASHFLOW_INTEGRATION_KEY` - API authentication key
- `CASHFLOW_COMPANY_ID` - Your company ID in Cashflow

### 2. Copy the Client

```bash
cp cashflow_client.ts <pitix-project>/app/service/cashflow_client.ts
```

### 3. Add Environment Variables

```bash
# Add to your .env or env.value
CASHFLOW_INTEGRATION_KEY=<your-key>
CASHFLOW_COMPANY_ID=1
CASHFLOW_API_URL_PROD=https://cashflow-api-291129507535.asia-southeast1.run.app
```

### 4. Integrate

Add to your sale completion flow:

```typescript
import { getCashflowClient } from "app/service/cashflow_client";

// After sale is completed
const client = getCashflowClient(env);
await client.importSale({
  saleId: sale.id,
  saleNumber: sale.sale_number,
  lines: sale.items.map(item => ({
    name: item.product_name,
    quantity: item.quantity,
    unitPrice: item.unit_price,
  })),
});
```

See `INTEGRATION_GUIDE.md` for detailed instructions.

---

## What Gets Synced

| Pitix Event | Cashflow Result |
|-------------|-----------------|
| Sale completed | Invoice created |
| Payment received | Payment recorded |
| Sale canceled/refunded | Credit note created |

---

## Key Features

✅ **Idempotent** - Safe to retry, no duplicates  
✅ **Auto-retry** - Handles network failures automatically  
✅ **Entity mapping** - Customers and items synced once  
✅ **Non-blocking** - Won't slow down POS operations  

---

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /integrations/piti/companies/:id/sales` | Import completed sale |
| `POST /integrations/piti/companies/:id/refunds` | Import refund/return |

See `API_REFERENCE.md` for full documentation.

---

## Important Rules

1. **Inventory stays in Pitix** - Cashflow only tracks finances
2. **One idempotency key per sale** - Use `piti:sale:<saleId>:completed`
3. **Retry on 5xx/429 only** - Don't retry on 4xx errors

---

## Files to Copy

| File | Copy To |
|------|---------|
| `cashflow_client.ts` | `app/service/cashflow_client.ts` |

---

## Support

For issues:
1. Check `INTEGRATION_GUIDE.md` troubleshooting section
2. Verify credentials and environment variables
3. Contact Cashflow team with request/response logs

---

## Changelog

- **v1.0.0** - Initial release with sale and refund endpoints

