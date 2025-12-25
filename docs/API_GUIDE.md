## Cashflow API — Usage Guide & Standards (source of truth)

### Base URLs

- **Local API**: `http://localhost:8080`
- **Cloud Run API (example from Cloud Build)**: `https://cashflow-api-291129507535.asia-southeast1.run.app`

> Open question: confirm final **dev/staging/prod** URLs and naming conventions.

### Auth

- **Auth type**: JWT (Bearer token)
- **How to obtain**:
  - `POST /register` → `{ token, user }`
  - `POST /login` → `{ token, user }`
- **How to send**:
  - Header: `Authorization: Bearer <token>`
- **Tenant binding**:
  - Token includes `companyId`; server enforces all access within that tenant.

### Required headers

- **Authenticated endpoints**: `Authorization: Bearer <token>`
- **Write endpoints** (POST/PUT/etc): **`Idempotency-Key: <uuid>`** (required for posting/payment/reversal/close flows; frontend auto-adds this for non-GET writes)
- **Content type**: `Content-Type: application/json` (for JSON bodies)

### Error format (current)

Most endpoints return:

- `400/401/403/404`: `{ "error": "message" }`

Notes:

- Some low-level errors may be Fastify default shaped (e.g., JWT verify failures).
- Some endpoints throw errors with `statusCode` to produce consistent `error` messages.

### Pagination / filtering conventions (current)

- **List endpoints** mostly return full arrays (no pagination yet).
- When present:
  - `GET /companies/:companyId/journal-entries?from=YYYY-MM-DD&to=YYYY-MM-DD&take=50`
  - `GET /companies/:companyId/items/:itemId/stock-moves?take=50`

### Core endpoints (high-signal)

#### Health

- `GET /health` → `{ "status": "ok" }`

#### Auth

- `POST /register`
  - Body:
    - `email` (string)
    - `password` (string)
    - `companyName` (string)
    - `name` (string, optional)
  - Response: `{ token, user }`

- `POST /login`
  - Body: `email`, `password`
  - Response: `{ token, user }`

#### Company / tenant

- `GET /companies` (JWT required)
  - Returns **only** the authenticated company (array of length 0/1).

- `GET /companies/:companyId/settings` (JWT required)
- `PUT /companies/:companyId/settings` (JWT required)

#### Chart of accounts + banking accounts

- `GET /companies/:companyId/accounts`
- `POST /companies/:companyId/accounts`

- `GET /companies/:companyId/banking-accounts`
- `GET /companies/:companyId/banking-accounts/:bankingAccountId`
- `POST /companies/:companyId/banking-accounts`

#### Books (Customers, Vendors, Items)

- `GET /companies/:companyId/customers`
- `POST /companies/:companyId/customers`

- `GET /companies/:companyId/vendors`
- `POST /companies/:companyId/vendors`

- `GET /companies/:companyId/items`
- `GET /companies/:companyId/items/:itemId`
- `POST /companies/:companyId/items`

#### Invoices (AR) + payments

- `GET /companies/:companyId/invoices`
- `GET /companies/:companyId/invoices/:invoiceId`
- `POST /companies/:companyId/invoices` (creates **DRAFT**)

- `POST /companies/:companyId/invoices/:invoiceId/post`
  - **Requires** `Idempotency-Key`
  - Effect:
    - Creates immutable `JournalEntry` + `JournalLine` rows
    - Emits outbox events (`journal.entry.created`, `invoice.posted`)
    - If tracked inventory: applies WAC stock moves + COGS posting

- `POST /companies/:companyId/invoices/:invoiceId/payments`
  - **Requires** `Idempotency-Key`
  - Effect:
    - JE (Dr cash/bank, Cr AR)
    - Updates invoice status (POSTED→PARTIAL→PAID)
    - Emits outbox events (`journal.entry.created`, `payment.recorded`)

- `POST /companies/:companyId/invoices/:invoiceId/payments/:paymentId/reverse`
  - **Requires** `Idempotency-Key`
  - Effect:
    - Reversal JE + audit events (`journal.entry.created`, `journal.entry.reversed`, `payment.reversed`)

#### Integrations: Piti (POS → Finance)

- `POST /integrations/piti/companies/:companyId/sales`
  - Service-to-service auth: `X-Integration-Key`
  - Idempotent: `Idempotency-Key`
  - Creates **POSTED** invoice + JE and optionally records payments
  - See `docs/PITI_INTEGRATION.md`

- `POST /integrations/piti/companies/:companyId/refunds`
  - Service-to-service auth: `X-Integration-Key`
  - Idempotent: `Idempotency-Key`
  - Creates **POSTED** credit note + JE
  - See `docs/PITI_INTEGRATION.md`

#### Bills / Expenses (AP) + payments

- `GET /companies/:companyId/expenses`
- `GET /companies/:companyId/expenses/:expenseId`
- `POST /companies/:companyId/expenses` (creates **DRAFT**)
- `POST /companies/:companyId/expenses/:expenseId/post` (**Idempotency-Key**)
- `POST /companies/:companyId/expenses/:expenseId/payments` (**Idempotency-Key**)

#### Purchase bills (inventory + AP)

- `GET /companies/:companyId/purchase-bills`
- `GET /companies/:companyId/purchase-bills/:purchaseBillId`
- `POST /companies/:companyId/purchase-bills` (creates **DRAFT**, sequential `PB-000001`)
- `POST /companies/:companyId/purchase-bills/:purchaseBillId/post` (**Idempotency-Key**) → stock receipt + JE
- `POST /companies/:companyId/purchase-bills/:purchaseBillId/payments` (**Idempotency-Key**)

#### Inventory

- `GET /companies/:companyId/warehouses`
- `POST /companies/:companyId/warehouses`

- `POST /companies/:companyId/inventory/opening-balance` (**Idempotency-Key**)
- `POST /companies/:companyId/inventory/adjustments` (**Idempotency-Key**)

- Reports:
  - `GET /companies/:companyId/reports/inventory-summary`
  - `GET /companies/:companyId/reports/inventory-valuation?asOf=...`
  - `GET /companies/:companyId/reports/inventory-movement?from=...&to=...`
  - `GET /companies/:companyId/reports/cogs-by-item?from=...&to=...`

#### Ledger + reporting

- `GET /companies/:companyId/journal-entries`
- `GET /companies/:companyId/journal-entries/:journalEntryId`

- `POST /journal-entries` (**Idempotency-Key**, legacy-ish endpoint; tenant derived from JWT)
- `POST /companies/:companyId/journal-entries/:journalEntryId/reverse` (**Idempotency-Key**)
- `POST /companies/:companyId/period-close?from=...&to=...` (**Idempotency-Key**)

- Reports:
  - `GET /companies/:companyId/reports/trial-balance?from=...&to=...`
  - `GET /companies/:companyId/reports/balance-sheet?asOf=...`
  - `GET /companies/:companyId/reports/profit-and-loss?from=...&to=...`
  - `GET /companies/:companyId/reports/cashflow?from=...&to=...`
  - `GET /companies/:companyId/reports/ap-aging?asOf=...`

### Curl examples (copy/paste)

#### Register → token

```bash
curl -sS -X POST 'http://localhost:8080/register' \
  -H 'Content-Type: application/json' \
  -d '{"email":"dev@example.com","password":"pass1234","companyName":"Acme Co","name":"Dev"}'
```

#### List accounts (tenant-scoped)

```bash
TOKEN='...'
COMPANY_ID='1'
curl -sS "http://localhost:8080/companies/${COMPANY_ID}/accounts" \
  -H "Authorization: Bearer ${TOKEN}"
```

#### Post an invoice (idempotent)

```bash
TOKEN='...'
COMPANY_ID='1'
INVOICE_ID='123'

curl -sS -X POST "http://localhost:8080/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/post" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Idempotency-Key: $(uuidgen | tr 'A-Z' 'a-z')" \
  -H "Content-Type: application/json" \
  -d '{}'
```

### Frontend/mobile usage patterns

- **Frontend (Next.js)**:
  - Use `fetchApi(...)` in `frontend/src/lib/api.ts` (adds JWT + idempotency key automatically).
- **Mobile**:
  - Store token securely (Keychain/Keystore).
  - Add `Authorization: Bearer <token>` header on all requests.
  - For any write/post/payment/reversal: generate a new UUID per user action and send `Idempotency-Key`.

### How to add a new endpoint safely (checklist)

- **Tenant safety**
  - If route includes `:companyId`, call `requireCompanyIdParam(request, reply)` and use that value for all DB queries.
  - Never trust `companyId` in request body; use `forbidClientProvidedCompanyId(...)` if needed.
- **Money safety**
  - For any ledger-impacting change, use `postJournalEntry(...)` and never update ledger rows.
  - If a change must “undo” something, create a reversal entry and record audit metadata.
- **Idempotency**
  - For write endpoints: require `Idempotency-Key` and wrap work with `runIdempotentRequest(...)`.
- **Concurrency**
  - For high-risk actions (posting, payments, stock moves), acquire Redis locks via `withLockBestEffort(...)` / `withLocksBestEffort(...)`.
- **Events**
  - Insert an outbox `Event` row in the same DB transaction as your business change.
  - Prefer eventType names like `invoice.posted`, `payment.recorded`.
  - Optionally “fast path” publish; always rely on outbox publisher for eventual delivery.
- **Worker projections**
  - If you add new projections, implement in `src/worker.ts` and wrap with `runIdempotent(...)`.
- **Docs**
  - Update `docs/API_GUIDE.md` and `docs/HOW_TO_EXTEND.md` with the new endpoint and its invariants.


