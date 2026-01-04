# Pitix → Cashflow Integration Guide

**For: Pitix Development Team**  
**Version:** 1.0.0  
**Date:** January 2026

---

## Quick Start

This guide will help you integrate Cashflow's finance API into Pitix POS. After integration, every completed sale in Pitix will automatically create an invoice in Cashflow.

### Time Estimate: ~2 hours

---

## Prerequisites

1. Cashflow integration key (contact Cashflow team)
2. Cashflow company ID assigned to your business
3. Access to Pitix codebase

---

## Step 1: Environment Variables

Add these to your environment configuration:

```bash
# .env or env.value

# Cashflow Integration
CASHFLOW_INTEGRATION_KEY=<provided-by-cashflow-team>
CASHFLOW_COMPANY_ID=1
CASHFLOW_API_URL_PROD=https://cashflow-api-291129507535.asia-southeast1.run.app
CASHFLOW_API_URL_DEV=http://localhost:8080
```

---

## Step 2: Install the Cashflow Client

Copy the provided TypeScript files to your Pitix project:

```bash
# From your pitix.core directory
cp <path-to>/cashflow_client.ts app/service/cashflow_client.ts
```

### File: `app/service/cashflow_client.ts`

This file provides:
- `CashflowClient` class with retry logic
- `getCashflowClient(env)` singleton factory
- Type definitions for requests/responses

### Update `app/service/index.ts`:

```typescript
export * from './gcs_storage';
export * from './http_client';
export * from './mail';
export * from './sms';
export * from './sync';
export * from './firebase';
export * from './otp';
export * from './account_notification';
export * from './cashflow_client';  // Add this line
```

---

## Step 3: Integrate with Sale Flow

You have two options for integration:

### Option A: Modify `sale_helper.ts` (Recommended)

Update `app/graph/pos/sale_helper.ts`:

```typescript
import { PrismaClient } from "./client";
import { Sale } from "./generated/type-graphql";
import { TransactionClient } from "./utils";
import { getCashflowClient, CashflowSaleRequest } from "app/service/cashflow_client";

// ... existing code ...

// Add this function
const syncToCashflow = async (sale: Sale, env: string) => {
  // Skip if not enabled
  if (!process.env.CASHFLOW_INTEGRATION_KEY) return;
  
  // Only sync completed sales
  if (sale.sale_status !== "COMPLETED") return;

  try {
    const client = getCashflowClient(env as any);
    
    const request: CashflowSaleRequest = {
      saleId: sale.id,
      saleNumber: sale.sale_number ?? undefined,
      saleDate: sale.sale_date?.toISOString(),
      currency: "MMK",
      
      customer: sale.customer ? {
        externalCustomerId: sale.customer.id,
        name: sale.customer.name ?? "Walk-in Customer",
        phone: sale.customer.phone ?? null,
      } : {
        name: "Walk-in Customer",
      },
      
      lines: (sale.items ?? []).map((item: any) => ({
        externalProductId: item.product_id,
        sku: item.sku,
        name: item.product_name ?? item.name ?? "Item",
        quantity: Number(item.quantity),
        unitPrice: Number(item.unit_price ?? item.selling_price),
        discountAmount: Number(item.discount_amount ?? 0),
        taxRate: Number(item.tax_rate ?? 0),
      })),
      
      payments: sale.payment_status === "PAID" ? [{
        cashflowAccountCode: mapPaymentMethod(sale.payment_method),
        amount: Number(sale.net_amount ?? sale.gross_amount),
        paidAt: sale.sale_date?.toISOString(),
      }] : undefined,
    };
    
    const result = await client.importSale(request);
    console.log(`[Cashflow] Synced sale ${sale.sale_number} → Invoice ${result.invoiceNumber}`);
  } catch (error: any) {
    console.error(`[Cashflow] Failed to sync sale ${sale.sale_number}:`, error.message);
  }
};

// Helper function
const mapPaymentMethod = (method: string | null | undefined): string => {
  const mapping: Record<string, string> = {
    "cash": "1000",
    "kbzpay": "1001",
    "ayapay": "1002",
    "wavepay": "1003",
    "card": "1010",
  };
  return mapping[(method ?? "cash").toLowerCase()] ?? "1000";
};

// Modify afterSaleAction
const afterSaleAction = async (tx: PrismaClient, sale: Sale, env: string) => {
  await useCoupon(tx, sale, env);
  await usePoint(tx, sale, env);
  
  // Add Cashflow sync (runs async, won't block sale)
  syncToCashflow(sale, env).catch(console.error);
};

// Add for cancellations/refunds
const syncRefundToCashflow = async (sale: Sale, env: string) => {
  if (!process.env.CASHFLOW_INTEGRATION_KEY) return;
  
  try {
    const client = getCashflowClient(env as any);
    
    const result = await client.importRefund({
      refundId: `${sale.id}_refund`,
      saleId: sale.id,
      refundNumber: `RF-${sale.sale_number}`,
      refundDate: new Date().toISOString(),
      currency: "MMK",
      
      customer: sale.customer ? {
        externalCustomerId: sale.customer.id,
        name: sale.customer.name ?? "Walk-in Customer",
      } : undefined,
      
      lines: (sale.items ?? []).map((item: any) => ({
        externalProductId: item.product_id,
        name: item.product_name ?? "Item",
        quantity: Number(item.quantity),
        unitPrice: Number(item.unit_price),
      })),
    });
    
    console.log(`[Cashflow] Synced refund ${sale.sale_number} → CreditNote ${result.creditNoteNumber}`);
  } catch (error: any) {
    console.error(`[Cashflow] Failed to sync refund:`, error.message);
  }
};

// Modify cancelSaleAction
const cancelSaleAction = async (tx: PrismaClient, sale: Sale, env: string) => {
  await refundPoint(tx, sale, env);
  
  // Add Cashflow refund sync
  syncRefundToCashflow(sale, env).catch(console.error);
};

export const saleHelper = {
  beforeSaleAction,
  afterSaleAction,
  cancelSaleAction,
};
```

### Option B: Modify Trigger (Alternative)

Update `app/graph/pos/triggers/updateOnSale2.ts`:

```typescript
import { cron, defaultTimezone } from 'app/helpers';
import { Trigger } from 'app/interface';
import { Sale } from '../generated/type-graphql';
import { closingStockHistoryAndDailyStock, generateDailySale } from '../utils';
import { sendGivePointEvent, sendRefundPointEvent } from '../helpers';
import { Syncer } from 'app/service';
import { getCashflowClient } from 'app/service/cashflow_client';  // Add import

export const updateOneSale2: Trigger = {
    type: "Mutation",
    path: "updateOneSale2",
    callback: async (resolve, root, args, context, info) => {
        const result = await resolve(root, args, context, info) as Sale;
        if (result.id) {
            cron(async () => {
                const sale = result;
                if (sale) {
                    // ... existing code ...
                    
                    // Add Cashflow sync for completed sales
                    if (sale.sale_status === "COMPLETED" && process.env.CASHFLOW_INTEGRATION_KEY) {
                        try {
                            const client = getCashflowClient(context.env);
                            await client.importSale({
                                saleId: sale.id,
                                saleNumber: sale.sale_number,
                                saleDate: sale.sale_date?.toISOString(),
                                currency: "MMK",
                                customer: sale.customer ? {
                                    externalCustomerId: sale.customer.id,
                                    name: sale.customer.name ?? "Walk-in Customer",
                                } : undefined,
                                lines: (sale.items ?? []).map((item: any) => ({
                                    externalProductId: item.product_id,
                                    name: item.product_name ?? "Item",
                                    quantity: Number(item.quantity),
                                    unitPrice: Number(item.unit_price),
                                })),
                                payments: sale.payment_status === "PAID" ? [{
                                    amount: Number(sale.net_amount),
                                }] : undefined,
                            });
                            console.log(`[Cashflow] Synced sale ${sale.sale_number}`);
                        } catch (error: any) {
                            console.error(`[Cashflow] Sync failed:`, error.message);
                        }
                    }
                    
                    // ... rest of existing code ...
                }
            }).then(console.log).catch(console.error);
        }
        return result;
    }
};
```

---

## Step 4: Test the Integration

### 4.1 Verify Environment

```bash
# Check env vars are set
echo $CASHFLOW_INTEGRATION_KEY
echo $CASHFLOW_COMPANY_ID
```

### 4.2 Create a Test Sale

1. Create a sale in Pitix POS
2. Complete the sale
3. Check logs for `[Cashflow] Synced sale...`

### 4.3 Verify in Cashflow

- Check Cashflow dashboard for the new invoice
- Verify invoice number matches format: `INV-PITI-<saleNumber>`

### 4.4 Test Idempotency

1. Note the sale ID from step 4.2
2. Manually trigger sync again with same sale
3. Should return same invoice ID (no duplicate)

---

## Step 5: Handle Edge Cases

### Payment Methods Mapping

Configure Cashflow account codes for your payment methods:

| Pitix Payment Method | Cashflow Account Code | Account Name |
|---------------------|----------------------|--------------|
| cash | 1000 | Cash on Hand |
| kbzpay | 1001 | KBZ Pay |
| ayapay | 1002 | AYA Pay |
| wavepay | 1003 | Wave Pay |
| card | 1010 | Credit Card |
| bank | 1020 | Bank Transfer |

**Note:** Contact Cashflow team to ensure these accounts exist.

### Error Handling

The client handles retries automatically for:
- Network errors
- HTTP 429 (rate limit)
- HTTP 5xx (server errors)

For HTTP 4xx errors, check:
- Is `saleId` provided?
- Do all lines have `quantity > 0` and `unitPrice > 0`?
- Is `taxRate` between 0 and 1?

### Logging Recommendations

```typescript
// Add structured logging
console.log(JSON.stringify({
  event: "cashflow_sync",
  saleId: sale.id,
  saleNumber: sale.sale_number,
  status: "success",
  invoiceId: result.invoiceId,
}));
```

---

## Troubleshooting

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| `invalid or missing integration key` | Wrong API key | Check `CASHFLOW_INTEGRATION_KEY` |
| `invalid companyId` | Company not found | Verify `CASHFLOW_COMPANY_ID` |
| `saleId is required` | Missing saleId | Ensure sale.id is passed |
| `at least one line is required` | Empty lines array | Check sale.items mapping |
| `Idempotency-Key header is required` | Missing header | Client adds this automatically |

### Debug Mode

Enable verbose logging:

```typescript
const client = getCashflowClient(env);

// Before importSale
console.log("[Cashflow] Request:", JSON.stringify(request, null, 2));

const result = await client.importSale(request);

// After success
console.log("[Cashflow] Response:", JSON.stringify(result, null, 2));
```

### Network Issues

If Cashflow API is unreachable:
1. Check network connectivity
2. Verify firewall allows outbound HTTPS
3. Try curl test from same server

```bash
curl -I https://cashflow-api-291129507535.asia-southeast1.run.app/health
```

---

## Integration Checklist

Before going live:

- [ ] Environment variables configured
- [ ] `cashflow_client.ts` installed
- [ ] `sale_helper.ts` or trigger updated
- [ ] Payment method mapping verified
- [ ] Test sale synced successfully
- [ ] Idempotency verified
- [ ] Error handling tested
- [ ] Logs monitored

---

## Files in This Package

| File | Purpose | Install Location |
|------|---------|------------------|
| `cashflow_client.ts` | API client with retry | `app/service/` |
| `cashflow_sale_helper.ts` | Integration helpers | Reference only |
| `API_REFERENCE.md` | Complete API docs | Reference |
| `INTEGRATION_GUIDE.md` | This guide | Reference |

---

## Support

- **Cashflow Team:** [contact info]
- **API Status:** Check Cashflow health endpoint
- **Issues:** Include request/response logs when reporting

---

## Changelog

### v1.0.0 (January 2026)
- Initial release
- Sale import endpoint
- Refund import endpoint
- Idempotency support
- Retry with exponential backoff

