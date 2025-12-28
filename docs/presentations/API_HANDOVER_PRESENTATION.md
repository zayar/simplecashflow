# Cashflow App — API Handover (Presentation)

Use this as a **slide deck in Markdown**. Copy each `---` section into Google Slides.

---

## Slide 1 — API purpose + consumers

- **API** is the *single entry point* for clients:
  - Next.js web (`frontend/`)
  - Mobile PWA (`mobile-pwa/`)
  - Service-to-service integrations (e.g., Piti)
- Primary responsibilities:
  - authenticated, tenant-scoped CRUD
  - “posting” actions that create immutable ledger entries
  - emit domain events (outbox → Pub/Sub)

---

## Slide 2 — Base URLs + environments

- Local: `http://localhost:8080`
- Cloud Run (example): `https://cashflow-api-291129507535.asia-southeast1.run.app`
- Handover action item: confirm final **dev/staging/prod** URLs and rotation policy for secrets.

---

## Slide 3 — Auth model (JWT)

- **JWT Bearer token**
  - Obtain via:
    - `POST /register`
    - `POST /login`
  - Send via:
    - `Authorization: Bearer <token>`
- Token includes `companyId` → backend enforces tenant boundary.

---

## Slide 4 — Required headers (most common reason requests fail)

- **All authenticated requests**
  - `Authorization: Bearer <token>`
- **Write endpoints** (POST/PUT/PATCH/DELETE; especially posting/payment/reversal/close)
  - `Idempotency-Key: <uuid or stable string>`
- **Integrations**
  - `X-Integration-Key: <shared secret>`
- JSON bodies:
  - `Content-Type: application/json`

---

## Slide 5 — Error format + retry rules

- Typical error shape:
  - `4xx/5xx` → `{ "error": "message" }`
- Client retry guidance:
  - **retry** on network errors, **429**, and **5xx**
  - **do not retry** on **4xx** (except 429)

---

## Slide 6 — Tenant model (how paths are structured)

- Most endpoints are tenant-scoped:
  - `/companies/:companyId/...`
- Rule:
  - `:companyId` must equal JWT `companyId`
  - any attempt to access other tenants should be **403**

---

## Slide 7 — Core endpoint groups (map)

- **Health**: `/health`
- **Auth**: `/register`, `/login`
- **Company/Settings**: `/companies`, `/companies/:companyId/settings`
- **Chart of accounts**: `/companies/:companyId/accounts`
- **Banking accounts**: `/companies/:companyId/banking-accounts`
- **Books**:
  - customers, vendors, items
  - invoices, credit notes, payments
  - expenses + payments
- **Purchasing**: purchase bills + payments
- **Inventory**: warehouses, opening balance, adjustments, reports
- **Ledger/Reports**: journal entries, reversals, period close, financial statements
- **Taxes**: tax rates/groups CRUD
- **Integrations**: Piti endpoints

---

## Slide 8 — Health (for monitoring)

- `GET /health` → `{ "status": "ok" }`

---

## Slide 9 — Auth endpoints (bootstrap a tenant)

- `POST /register`
  - creates: `Company` + defaults (accounts, warehouse, etc.) + `User`
  - returns: `{ token, user }`
- `POST /login`
  - returns: `{ token, user }`

> Speaker notes: Registration is the main “seed” mechanism. In local dev, this is the fastest way to bootstrap a company with a valid chart of accounts.

---

## Slide 10 — Chart of accounts + banking accounts

- Accounts:
  - `GET /companies/:companyId/accounts`
  - `POST /companies/:companyId/accounts`
- Banking accounts:
  - `GET /companies/:companyId/banking-accounts`
  - `GET /companies/:companyId/banking-accounts/:bankingAccountId`
  - `POST /companies/:companyId/banking-accounts`

> Speaker notes: Banking accounts map 1:1 to an `Account` (ASSET) and are used when recording payments.

---

## Slide 11 — Books (master data): customers, vendors, items

- Customers:
  - `GET /companies/:companyId/customers`
  - `POST /companies/:companyId/customers`
- Vendors:
  - `GET /companies/:companyId/vendors`
  - `POST /companies/:companyId/vendors`
- Items:
  - `GET /companies/:companyId/items`
  - `GET /companies/:companyId/items/:itemId`
  - `POST /companies/:companyId/items`

> Speaker notes: For inventory tracked items (`trackInventory=true`), posting invoices triggers stock moves and COGS; integration-created items may set `trackInventory=false` intentionally.

---

## Slide 12 — Invoices (AR) lifecycle (most important flow)

- Create draft:
  - `POST /companies/:companyId/invoices`
- Post invoice (creates immutable ledger entry + events):
  - `POST /companies/:companyId/invoices/:invoiceId/post`
  - **requires** `Idempotency-Key`
- Record payment:
  - `POST /companies/:companyId/invoices/:invoiceId/payments`
  - **requires** `Idempotency-Key`
- Reverse payment:
  - `POST /companies/:companyId/invoices/:invoiceId/payments/:paymentId/reverse`
  - **requires** `Idempotency-Key`

> Speaker notes: Draft CRUD is not where correctness lives. Correctness starts at posting: it must be balanced, idempotent, and lock-protected.

---

## Slide 13 — Expenses (AP) lifecycle

- Create draft:
  - `POST /companies/:companyId/expenses`
- Post expense:
  - `POST /companies/:companyId/expenses/:expenseId/post` (**Idempotency-Key**)
- Pay expense:
  - `POST /companies/:companyId/expenses/:expenseId/payments` (**Idempotency-Key**)
- Read:
  - `GET /companies/:companyId/expenses`
  - `GET /companies/:companyId/expenses/:expenseId`

---

## Slide 14 — Purchase bills (inventory + AP)

- Draft:
  - `POST /companies/:companyId/purchase-bills`
- Post (inventory receipt + JE):
  - `POST /companies/:companyId/purchase-bills/:purchaseBillId/post` (**Idempotency-Key**)
- Pay:
  - `POST /companies/:companyId/purchase-bills/:purchaseBillId/payments` (**Idempotency-Key**)
- Read:
  - `GET /companies/:companyId/purchase-bills`
  - `GET /companies/:companyId/purchase-bills/:purchaseBillId`

---

## Slide 15 — Inventory endpoints (WAC model)

- Warehouses:
  - `GET /companies/:companyId/warehouses`
  - `POST /companies/:companyId/warehouses`
- Stock-affecting operations (writes → idempotent):
  - `POST /companies/:companyId/inventory/opening-balance` (**Idempotency-Key**)
  - `POST /companies/:companyId/inventory/adjustments` (**Idempotency-Key**)
- Inventory reports:
  - `/companies/:companyId/reports/inventory-summary`
  - `/companies/:companyId/reports/inventory-valuation?asOf=...`
  - `/companies/:companyId/reports/inventory-movement?from=...&to=...`
  - `/companies/:companyId/reports/cogs-by-item?from=...&to=...`

---

## Slide 16 — Ledger + financial reporting endpoints

- Journal entries:
  - `GET /companies/:companyId/journal-entries`
  - `GET /companies/:companyId/journal-entries/:journalEntryId`
  - Reverse: `POST /companies/:companyId/journal-entries/:journalEntryId/reverse` (**Idempotency-Key**)
- Period close:
  - `POST /companies/:companyId/period-close?from=...&to=...` (**Idempotency-Key**)
- Reports:
  - Trial balance: `/companies/:companyId/reports/trial-balance?from=...&to=...`
  - Balance sheet: `/companies/:companyId/reports/balance-sheet?asOf=...`
  - Profit & loss: `/companies/:companyId/reports/profit-and-loss?from=...&to=...`
  - Cashflow: `/companies/:companyId/reports/cashflow?from=...&to=...`
  - AP aging: `/companies/:companyId/reports/ap-aging?asOf=...`

---

## Slide 17 — Taxes (module endpoints)

- List:
  - `GET /companies/:companyId/taxes` (combined view)
- Tax rates:
  - `POST /companies/:companyId/tax-rates`
- Tax groups:
  - `POST /companies/:companyId/tax-groups`

> Speaker notes: Tax is stored per line on invoices/credit notes (`taxRate`, `taxAmount`). Revenue remains subtotal; tax posts to Tax Payable liability.

---

## Slide 18 — Integrations: Piti (service-to-service)

- Completed sale import:
  - `POST /integrations/piti/companies/:companyId/sales`
  - headers: `X-Integration-Key`, `Idempotency-Key`
- Refund import:
  - `POST /integrations/piti/companies/:companyId/refunds`
  - headers: `X-Integration-Key`, `Idempotency-Key`

> Speaker notes: Piti is system-of-record for POS inventory; integration-created items set `trackInventory=false` to avoid Cashflow stock moves.

---

## Slide 19 — Client implementation notes

- **Frontend (Next.js)** uses `frontend/src/lib/api.ts`
  - automatically adds JWT header
  - automatically adds `Idempotency-Key` for non-GET requests
- Mobile clients should do the same:
  - store JWT securely
  - generate a new UUID per user action for `Idempotency-Key`

---

## Slide 20 — “How to add a new endpoint” checklist (for the team)

- Tenant:
  - derive `companyId` from JWT and validate route params
- Idempotency:
  - require `Idempotency-Key` for writes that must not duplicate
- Concurrency:
  - lock for money/inventory actions
- Ledger:
  - never update posted ledger rows; use posting/reversal pattern
- Events:
  - insert outbox `Event` rows for downstream consumers
- Docs:
  - update `docs/API_GUIDE.md`


