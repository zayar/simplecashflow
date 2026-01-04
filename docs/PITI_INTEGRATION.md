## Piti ↔ Cashflow Integration (Finance via API)

This document is written for the **Piti development team**.

> **📦 Complete Integration Package Available**
>
> See the `docs/piti-integration/` folder for:
> - `README.md` - Quick start guide
> - `INTEGRATION_GUIDE.md` - Step-by-step setup
> - `API_REFERENCE.md` - Complete API documentation
> - `cashflow_client.ts` - Ready-to-use TypeScript client

### Production environment (current)

- **API Base URL (PROD)**: `https://cashflow-api-291129507535.asia-southeast1.run.app`
- **Company for testing**: `companyId=1`

### Goal (system-of-record split)

- **Piti = System of Record for operational inventory + POS sales**
- **Cashflow = System of Record for finance / accounting**

Cashflow will **not** manage POS stock. Items created by this integration are created with:
- `trackInventory=false`

That prevents Cashflow from making stock moves during invoice/credit-note posting.

---

## Authentication

### Service-to-service (recommended)

Send:
- Header **`X-Integration-Key`** = the shared secret configured in Cashflow env:
  - `PITI_INTEGRATION_API_KEY`

Notes:
- Treat `X-Integration-Key` like a password. Do not commit it to code or share in plain chat.
- Cashflow may rotate the key; your service should support updating it.

### Idempotency (required for writes)

All write calls must include:
- Header **`Idempotency-Key`** = a unique string per user action.

Recommendation:
- For sale completion: `piti:sale:<saleId>:completed`
- For refund: `piti:refund:<refundId>`

This makes retries safe (Cashflow will return the previously stored response).

---

## Required behavior (must follow)

### Retry policy

- Retry only on **network errors**, **HTTP 429**, and **HTTP 5xx**
- Use exponential backoff (example): 1s → 2s → 4s → 8s → 16s (cap ~60s)
- Do **not** retry on **HTTP 4xx** (except 429)

### Inventory rule (critical)

- Piti is the operational inventory system of record.
- Cashflow will **never** track POS stock for integration-created items:
  - Items created/reused by this integration have `trackInventory=false`

---

## Endpoint: Import a COMPLETED sale (creates invoice + optional payment)

### `POST /integrations/piti/companies/:companyId/sales`

Creates a **POSTED** invoice in Cashflow, posts the required journal entry, and optionally records payment(s).

#### Headers

- `X-Integration-Key: <PITI_INTEGRATION_API_KEY>`
- `Idempotency-Key: piti:sale:<saleId>:completed`
- `Content-Type: application/json`

#### Body

```json
{
  "saleId": "12345",
  "saleNumber": "SO-000123",
  "saleDate": "2025-12-25T10:30:00.000Z",
  "currency": "MMK",
  "customer": {
    "externalCustomerId": "c-7788",
    "name": "Walk-in Customer",
    "phone": "0991234567",
    "email": null
  },
  "lines": [
    {
      "externalProductId": "p-100",
      "sku": "SKU-100",
      "name": "Coca Cola 330ml",
      "quantity": 2,
      "unitPrice": 1500,
      "discountAmount": 0,
      "taxRate": 0.0
    }
  ],
  "payments": [
    {
      "cashflowAccountCode": "1000",
      "amount": 3000,
      "paidAt": "2025-12-25T10:30:00.000Z"
    }
  ],
  "options": {
    "autoCreateCustomer": true,
    "autoCreateItems": true,
    "recordPayment": true
  }
}
```

#### How item/customer mapping works

- **Customer**
  - If `customer.externalCustomerId` is provided and already mapped → reuse.
  - Else try to find by `phone` (best-effort).
  - Else create a new Cashflow customer (if `autoCreateCustomer=true`).

- **Item**
  - If `externalProductId` is mapped → reuse mapped Cashflow item.
  - Else try to find by `sku` (best-effort).
  - Else create a new Cashflow item (if `autoCreateItems=true`).
  - New items are created with `trackInventory=false`.

#### Response

```json
{
  "saleId": "12345",
  "invoiceId": 101,
  "invoiceNumber": "INV-PITI-SO-000123",
  "invoiceStatus": "PAID",
  "journalEntryId": 555,
  "paymentIds": [77]
}
```

---

## Endpoint: Import a Refund/Return (creates posted credit note)

### `POST /integrations/piti/companies/:companyId/refunds`

Creates a **POSTED** credit note in Cashflow and posts the journal entry.

#### Headers

- `X-Integration-Key: <PITI_INTEGRATION_API_KEY>`
- `Idempotency-Key: piti:refund:<refundId>`
- `Content-Type: application/json`

#### Body

```json
{
  "refundId": "r-9001",
  "refundNumber": "RF-0001",
  "refundDate": "2025-12-25T12:00:00.000Z",
  "saleId": "12345",
  "currency": "MMK",
  "customer": {
    "externalCustomerId": "c-7788",
    "name": "Walk-in Customer",
    "phone": "0991234567"
  },
  "lines": [
    {
      "externalProductId": "p-100",
      "sku": "SKU-100",
      "name": "Coca Cola 330ml",
      "quantity": 1,
      "unitPrice": 1500,
      "discountAmount": 0,
      "taxRate": 0.0
    }
  ]
}
```

#### Response

```json
{
  "refundId": "r-9001",
  "creditNoteId": 501,
  "creditNoteNumber": "CN-PITI-RF-0001",
  "status": "POSTED",
  "journalEntryId": 900
}
```

---

## Local testing (curl)

### Production test (companyId=1)

```bash
export CASHFLOW_URL='https://cashflow-api-291129507535.asia-southeast1.run.app'
export COMPANY_ID='1'
export PITI_KEY='<SHARED_SECRET>'

curl -sS -X POST "$CASHFLOW_URL/integrations/piti/companies/$COMPANY_ID/sales" \
  -H "Content-Type: application/json" \
  -H "X-Integration-Key: $PITI_KEY" \
  -H "Idempotency-Key: piti:sale:SALE-TEST-001:completed" \
  -d '{
    "saleId":"SALE-TEST-001",
    "saleNumber":"SO-TEST-001",
    "saleDate":"2025-12-25T10:30:00.000Z",
    "currency":"MMK",
    "customer":{"externalCustomerId":"CUST-TEST-001","name":"Walk-in Customer","phone":"0990000000"},
    "lines":[{"externalProductId":"PROD-TEST-001","sku":"SKU-TEST-001","name":"Test Item","quantity":2,"unitPrice":1500,"discountAmount":0,"taxRate":0}],
    "payments":[{"cashflowAccountCode":"1000","amount":3000,"paidAt":"2025-12-25T10:30:00.000Z"}]
  }'
```

To verify idempotency: re-run the exact same command and confirm you get the same response.

### Local dev test (optional)

Assuming Cashflow API runs on `http://localhost:8080`:

```bash
export CASHFLOW_URL='http://localhost:8080'
export COMPANY_ID='1'
export PITI_KEY='your-dev-key'

curl -sS -X POST "$CASHFLOW_URL/integrations/piti/companies/$COMPANY_ID/sales" \
  -H "Content-Type: application/json" \
  -H "X-Integration-Key: $PITI_KEY" \
  -H "Idempotency-Key: piti:sale:12345:completed" \
  -d '{
    "saleId":"12345",
    "saleNumber":"SO-000123",
    "saleDate":"2025-12-25T10:30:00.000Z",
    "currency":"MMK",
    "customer":{"externalCustomerId":"c-7788","name":"Walk-in Customer","phone":"0991234567"},
    "lines":[{"externalProductId":"p-100","sku":"SKU-100","name":"Coca Cola 330ml","quantity":2,"unitPrice":1500,"discountAmount":0,"taxRate":0}],
    "payments":[{"cashflowAccountCode":"1000","amount":3000,"paidAt":"2025-12-25T10:30:00.000Z"}]
  }'
```

---

## Notes / Known limitations (current)

- Refund flow is supported via `POST /integrations/piti/companies/:companyId/refunds` (creates a POSTED credit note).
- Multi-currency is not supported if company `baseCurrency` is set (Cashflow is single-currency per company).

---

## For Pitix Team: Integration Package

A complete integration package is available at `docs/piti-integration/`:

```
docs/piti-integration/
├── README.md                 # Quick start (5 minutes)
├── INTEGRATION_GUIDE.md      # Step-by-step setup guide
├── API_REFERENCE.md          # Complete API documentation
├── cashflow_client.ts        # TypeScript client for Pitix
└── cashflow_sale_helper.ts   # Integration helper examples
```

The `cashflow_client.ts` file:
- Matches Pitix coding patterns (extends their HttpClient approach)
- Includes built-in retry with exponential backoff
- Handles idempotency keys automatically
- Provides TypeScript types for all requests/responses

Simply copy `cashflow_client.ts` to `app/service/cashflow_client.ts` in Pitix and follow the integration guide.

