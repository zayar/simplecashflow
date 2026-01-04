# Cashflow API Reference for Pitix Integration

**Version:** 1.0.0  
**Last Updated:** January 2026  
**Author:** Cashflow Team

---

## Overview

This document provides the complete API reference for integrating Pitix POS with Cashflow's finance/accounting system.

### System Architecture

```
┌─────────────────┐         ┌─────────────────┐
│                 │         │                 │
│   Pitix POS     │ ──────► │    Cashflow     │
│                 │  HTTP   │    (Finance)    │
│  - Inventory    │  REST   │                 │
│  - Sales        │         │  - Invoices     │
│  - Stock        │         │  - Journal      │
│                 │         │  - Payments     │
└─────────────────┘         └─────────────────┘
      SoT:                        SoT:
   Operations                   Accounting
```

### System of Record (SoT) Split

| Domain | System | Notes |
|--------|--------|-------|
| Inventory & Stock | **Pitix** | Piti manages all stock movements |
| Sales Operations | **Pitix** | Piti handles POS workflow |
| Financial Records | **Cashflow** | Invoices, journal entries, payments |
| Tax Reporting | **Cashflow** | Commercial tax calculations |

---

## Base URLs

| Environment | URL |
|-------------|-----|
| **Production** | `https://cashflow-api-291129507535.asia-southeast1.run.app` |
| **Development** | `http://localhost:8080` |

---

## Authentication

### Service-to-Service Authentication (Required)

All requests must include the integration key header:

```http
X-Integration-Key: <PITI_INTEGRATION_API_KEY>
```

**Security Notes:**
- Treat the key like a password
- Do not commit to version control
- Cashflow may rotate the key periodically
- Support updating the key in your configuration

### Request Headers (All Requests)

```http
Content-Type: application/json
X-Integration-Key: <your-integration-key>
Idempotency-Key: <unique-key-per-action>
```

---

## Idempotency (Required)

All write operations **MUST** include an `Idempotency-Key` header.

### Key Format Recommendations

| Operation | Key Format | Example |
|-----------|------------|---------|
| Sale completion | `piti:sale:<saleId>:completed` | `piti:sale:abc123:completed` |
| Refund/Return | `piti:refund:<refundId>` | `piti:refund:ref456` |

### Behavior

- Same idempotency key → same response (no duplicate processing)
- Cashflow stores responses in `IdempotentRequest` table
- Safe to retry on network failures

---

## Retry Policy

### When to Retry

| Scenario | Retry? | Notes |
|----------|--------|-------|
| Network error | ✅ Yes | Connection timeout, DNS failure |
| HTTP 429 | ✅ Yes | Rate limited, backoff required |
| HTTP 5xx | ✅ Yes | Server error, temporary |
| HTTP 4xx (except 429) | ❌ No | Client error, fix payload |

### Exponential Backoff Algorithm

```typescript
const delays = [1000, 2000, 4000, 8000, 16000, 32000, 60000];
// 1s → 2s → 4s → 8s → 16s → 32s → 60s (cap)

for (let attempt = 0; attempt < maxRetries; attempt++) {
  try {
    return await makeRequest();
  } catch (error) {
    if (!shouldRetry(error)) throw error;
    await sleep(delays[attempt] ?? 60000);
  }
}
```

---

## API Endpoints

### 1. Import Completed Sale

Creates a **POSTED** invoice in Cashflow with optional payment record.

```http
POST /integrations/piti/companies/:companyId/sales
```

#### Path Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| companyId | number | Yes | Cashflow company ID |

#### Request Body

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
    "email": "customer@example.com"
  },
  
  "lines": [
    {
      "externalProductId": "p-100",
      "sku": "SKU-100",
      "name": "Coca Cola 330ml",
      "quantity": 2,
      "unitPrice": 1500,
      "discountAmount": 0,
      "taxRate": 0.05
    },
    {
      "externalProductId": "p-101",
      "sku": "SKU-101",
      "name": "Pepsi 330ml",
      "quantity": 1,
      "unitPrice": 1400,
      "discountAmount": 100,
      "taxRate": 0.05
    }
  ],
  
  "payments": [
    {
      "cashflowAccountCode": "1000",
      "amount": 4265,
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

#### Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `saleId` | string | **Yes** | Unique Piti sale ID |
| `saleNumber` | string | No | Human-readable sale number |
| `saleDate` | string (ISO 8601) | No | Defaults to now |
| `currency` | string | No | Currency code (e.g., "MMK") |
| `customer` | object | No | Customer info |
| `customer.externalCustomerId` | string | No | Piti customer ID for mapping |
| `customer.name` | string | No | Customer name |
| `customer.phone` | string | No | Customer phone |
| `customer.email` | string | No | Customer email |
| `lines` | array | **Yes** | At least one line required |
| `lines[].externalProductId` | string | No | Piti product ID for mapping |
| `lines[].sku` | string | No | Product SKU |
| `lines[].name` | string | **Yes** | Product name |
| `lines[].quantity` | number | **Yes** | Quantity > 0 |
| `lines[].unitPrice` | number | **Yes** | Unit price > 0 |
| `lines[].discountAmount` | number | No | Line discount amount |
| `lines[].taxRate` | number | No | Tax rate as decimal (0.05 = 5%) |
| `payments` | array | No | Payment records |
| `payments[].cashflowAccountCode` | string | No | Account code (default: "1000" Cash) |
| `payments[].amount` | number | **Yes** | Payment amount > 0 |
| `payments[].paidAt` | string | No | Payment date (ISO 8601) |
| `options.autoCreateCustomer` | boolean | No | Default: true |
| `options.autoCreateItems` | boolean | No | Default: true |
| `options.recordPayment` | boolean | No | Default: true when payments provided |

#### Response (Success: 200)

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

#### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `saleId` | string | Echo of input saleId |
| `invoiceId` | number | Cashflow invoice ID |
| `invoiceNumber` | string | Generated invoice number |
| `invoiceStatus` | string | `POSTED`, `PARTIAL`, or `PAID` |
| `journalEntryId` | number | Journal entry ID |
| `paymentIds` | number[] | Array of payment IDs created |

---

### 2. Import Refund/Return

Creates a **POSTED** credit note in Cashflow.

```http
POST /integrations/piti/companies/:companyId/refunds
```

#### Request Body

```json
{
  "refundId": "r-9001",
  "saleId": "12345",
  "refundNumber": "RF-0001",
  "refundDate": "2025-12-25T12:00:00.000Z",
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
      "taxRate": 0.05
    }
  ]
}
```

#### Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `refundId` | string | **Yes** | Unique refund ID |
| `saleId` | string | No | Original sale ID (for linking) |
| `refundNumber` | string | No | Human-readable refund number |
| `refundDate` | string (ISO 8601) | No | Defaults to now |
| `currency` | string | No | Currency code |
| `customer` | object | No | Customer info |
| `lines` | array | **Yes** | Refunded items |

#### Response (Success: 200)

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

## Error Handling

### Error Response Format

```json
{
  "error": "descriptive error message"
}
```

### Common Error Codes

| HTTP Status | Meaning | Action |
|-------------|---------|--------|
| 400 | Bad Request | Fix the payload, do not retry |
| 401 | Unauthorized | Check X-Integration-Key |
| 404 | Not Found | Check companyId exists |
| 429 | Rate Limited | Retry with backoff |
| 500 | Server Error | Retry with backoff |

### Error Examples

```json
// Missing required field
{ "error": "saleId is required" }

// Invalid data
{ "error": "each line must have quantity > 0" }

// Missing header
{ "error": "Idempotency-Key header is required" }

// Auth failure
{ "error": "invalid or missing integration key" }
```

---

## Entity Mapping

Cashflow maintains a mapping table to prevent duplicates:

| Piti Entity | Cashflow Entity | Mapping Key |
|-------------|-----------------|-------------|
| Sale (saleId) | Invoice | `piti:Sale:<saleId>` |
| Refund (refundId) | CreditNote | `piti:Refund:<refundId>` |
| Customer (externalCustomerId) | Customer | `piti:Customer:<id>` |
| Product (externalProductId) | Item | `piti:Item:<id>` |

### How Mapping Works

1. **First request**: Creates new Cashflow entity, stores mapping
2. **Subsequent requests**: Returns existing entity (no duplicate)
3. **Same idempotency key**: Returns cached response

---

## Inventory Rule (Critical)

**Pitix remains the inventory system of record.**

Cashflow will:
- Create items with `trackInventory=false`
- Never modify stock quantities
- Only use items for financial reporting

**Do NOT expect Cashflow to manage inventory movements.**

---

## Testing

### cURL Examples

#### Test Sale Import (Production)

```bash
export CASHFLOW_URL='https://cashflow-api-291129507535.asia-southeast1.run.app'
export COMPANY_ID='1'
export PITI_KEY='<your-integration-key>'

curl -sS -X POST "$CASHFLOW_URL/integrations/piti/companies/$COMPANY_ID/sales" \
  -H "Content-Type: application/json" \
  -H "X-Integration-Key: $PITI_KEY" \
  -H "Idempotency-Key: piti:sale:TEST-$(date +%s):completed" \
  -d '{
    "saleId":"TEST-'"$(date +%s)"'",
    "saleNumber":"SO-TEST-001",
    "saleDate":"'"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"'",
    "currency":"MMK",
    "customer":{
      "externalCustomerId":"CUST-TEST",
      "name":"Test Customer",
      "phone":"0990000000"
    },
    "lines":[{
      "externalProductId":"PROD-TEST",
      "sku":"SKU-TEST",
      "name":"Test Item",
      "quantity":2,
      "unitPrice":1500,
      "discountAmount":0,
      "taxRate":0.05
    }],
    "payments":[{
      "cashflowAccountCode":"1000",
      "amount":3150,
      "paidAt":"'"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"'"
    }]
  }'
```

#### Test Refund Import

```bash
curl -sS -X POST "$CASHFLOW_URL/integrations/piti/companies/$COMPANY_ID/refunds" \
  -H "Content-Type: application/json" \
  -H "X-Integration-Key: $PITI_KEY" \
  -H "Idempotency-Key: piti:refund:RF-TEST-$(date +%s)" \
  -d '{
    "refundId":"RF-TEST-'"$(date +%s)"'",
    "refundNumber":"RF-TEST-001",
    "refundDate":"'"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"'",
    "currency":"MMK",
    "lines":[{
      "name":"Test Item",
      "quantity":1,
      "unitPrice":1500,
      "taxRate":0.05
    }]
  }'
```

#### Verify Idempotency

Run the same request twice with identical `Idempotency-Key` - you should get the same `invoiceId` both times.

---

## Postman Collection

A complete Postman collection is available at:
`docs/PITI_CASHFLOW_POSTMAN_COLLECTION.json`

Import it into Postman and configure environment variables:
- `CASHFLOW_URL`
- `COMPANY_ID`
- `PITI_KEY`

---

## Support

For integration issues:
1. Check error message in response
2. Verify headers are correct
3. Confirm idempotency key format
4. Contact Cashflow team with request/response logs

