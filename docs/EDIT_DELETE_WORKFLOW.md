## Status models (per document)

All documents are **tenant-scoped by `companyId`** and every POST/PUT/PATCH/DELETE must run with the JWT tenant context already used in the API.

- **Invoice**
  - `DRAFT` → editable
  - `APPROVED` → not editable (must be posted or deleted)
  - `POSTED` → immutable posting; edits happen via **adjustment journal entries**
  - `PARTIAL` / `PAID` → immutable posting; edits are blocked (reverse payments first)
  - `VOID` → immutable terminal state (void uses reversal JE + optional inventory reversal stock moves)

- **Credit Note**
  - `DRAFT` → editable
  - `APPROVED` → not editable (must be posted or deleted)
  - `POSTED` → immutable posting; edits happen via **adjustment journal entries**
  - `VOID` → immutable terminal state (void uses reversal JE + optional inventory reversal stock moves)

- **Expense (AP Bill)**
  - `DRAFT` → editable
  - `APPROVED` → not editable (must be posted or deleted)
  - `POSTED` → immutable posting; edits happen via **adjustment journal entries**
  - `PARTIAL` / `PAID` → immutable posting; edits are blocked (reverse payments first)
  - `VOID` → immutable terminal state (void uses reversal JE)

- **Purchase Bill**
  - `DRAFT` → editable
  - `APPROVED` → not editable (must be posted or deleted)
  - `POSTED` → immutable posting; edits happen via **adjustment journal entries** (only supported when it didn’t affect inventory)
  - `PARTIAL` / `PAID` → immutable posting; edits are blocked (reverse payments first)
  - `VOID` → immutable terminal state (void uses reversal JE + optional inventory reversal stock moves)

- **Journal Entry**
  - Always posted/immutable. “Edit/Delete” is implemented as:
    - **Void/Delete** → reversal entry (`/void` or `/reverse`)
    - **Edit** → reversal + corrected entry (`/adjust`)

## DB changes (Prisma + migration)

Implemented in:
- `prisma/schema.prisma`
- `prisma/migrations/20251222120000_document_void_and_adjustment/migration.sql`

### Added statuses
- `InvoiceStatus`: added `APPROVED`, `VOID`
- `CreditNoteStatus`: added `APPROVED`, `VOID`
- `ExpenseStatus`: added `APPROVED`, `VOID`
- `PurchaseBillStatus`: added `APPROVED`, `VOID`

### Added audit/void fields (high level)
- **Documents** (`Invoice`, `CreditNote`, `Expense`, `PurchaseBill`)
  - `voidedAt`, `voidReason`, `voidedByUserId`
  - `voidJournalEntryId` (links to the reversal JE created by void)
  - `lastAdjustmentJournalEntryId` (tracks the latest adjustment JE; prior one is reversed before creating a new one)
  - `updatedByUserId`

- **JournalEntry**
  - `voidedAt`, `voidReason`, `voidedByUserId`, `updatedByUserId`

Audit “who/when/why” is recorded in the existing `AuditLog` table via `writeAuditLog(...)`.

## API routes (exact) + payloads

### Common conventions
- **Auth**: all routes require JWT auth (existing `fastify.authenticate` hook).
- **Tenant isolation**: always use `companyId` path param.
- **Idempotency**:
  - Required via `Idempotency-Key` header for **DELETE**, **VOID**, **ADJUST**, and other ledger-impacting actions.
- **Reason/notes**:
  - Required for `*/adjust` and `*/void`.

### Invoices (`src/modules/books/books.routes.ts`)
- **Approve**
  - `POST /companies/:companyId/invoices/:invoiceId/approve`
  - Response: `{ id, status, invoiceNumber }`
- **Delete (unposted)**
  - `DELETE /companies/:companyId/invoices/:invoiceId`
  - Headers: `Idempotency-Key`
  - Response: `{ invoiceId, deleted: true }`
- **Adjust (posted)**
  - `POST /companies/:companyId/invoices/:invoiceId/adjust`
  - Headers: `Idempotency-Key`
  - Body:
    - `reason: string` (required)
    - `adjustmentDate?: string`
    - `dueDate?: string | null`
    - `customerNotes?: string | null`
    - `termsAndConditions?: string | null`
    - `lines: [{ itemId, description?, quantity, unitPrice?, taxRate?, incomeAccountId? }]` (required)
  - Response:
    - `{ invoiceId, status, adjustmentJournalEntryId, reversedPriorAdjustmentJournalEntryId, total }`
- **Void (posted)**
  - `POST /companies/:companyId/invoices/:invoiceId/void`
  - Headers: `Idempotency-Key`
  - Body: `{ reason: string, voidDate?: string }`
  - Response: `{ invoiceId, status: "VOID", voidJournalEntryId }`

### Credit Notes (`src/modules/books/books.routes.ts`)
- `POST /companies/:companyId/credit-notes/:creditNoteId/approve`
- `DELETE /companies/:companyId/credit-notes/:creditNoteId` (Idempotency-Key)
- `POST /companies/:companyId/credit-notes/:creditNoteId/adjust` (Idempotency-Key)
  - Body: `{ reason, adjustmentDate?, customerNotes?, termsAndConditions?, lines: [...] }`
- `POST /companies/:companyId/credit-notes/:creditNoteId/void` (Idempotency-Key)
  - Body: `{ reason, voidDate? }`

### Expenses (`src/modules/books/books.routes.ts`)
- `POST /companies/:companyId/expenses/:expenseId/approve`
- `DELETE /companies/:companyId/expenses/:expenseId` (Idempotency-Key)
- `POST /companies/:companyId/expenses/:expenseId/adjust` (Idempotency-Key)
  - Body: `{ reason, adjustmentDate?, vendorId?, dueDate?, description, amount, expenseAccountId? }`
- `POST /companies/:companyId/expenses/:expenseId/void` (Idempotency-Key)
  - Body: `{ reason, voidDate? }`

### Purchase Bills (`src/modules/purchases/purchaseBills.routes.ts`)
- `POST /companies/:companyId/purchase-bills/:purchaseBillId/approve`
- `DELETE /companies/:companyId/purchase-bills/:purchaseBillId` (Idempotency-Key)
- `POST /companies/:companyId/purchase-bills/:purchaseBillId/adjust` (Idempotency-Key)
  - Body: `{ reason, adjustmentDate?, lines: [...] }`
  - Note: adjustment is blocked if the bill already created stock moves (inventory-affecting).
- `POST /companies/:companyId/purchase-bills/:purchaseBillId/void` (Idempotency-Key)
  - Body: `{ reason, voidDate? }`

### Journal Entries (`src/modules/ledger/ledger.routes.ts`)
- Existing: `POST /companies/:companyId/journal-entries/:journalEntryId/reverse` (Idempotency-Key)
- New:
  - `POST /companies/:companyId/journal-entries/:journalEntryId/void` (Idempotency-Key)
    - Body: `{ reason, date? }`
  - `POST /companies/:companyId/journal-entries/:journalEntryId/adjust` (Idempotency-Key)
    - Body: `{ reason, date?, description?, lines:[{accountId,debit,credit}] }`
    - Response: `{ originalJournalEntryId, reversalJournalEntryId, correctedJournalEntryId }`

## Business rules (edit/delete by status)

| Document | DRAFT | APPROVED | POSTED | PARTIAL/PAID | VOID |
|---|---|---|---|---|---|
| Invoice | **PUT allowed**, **DELETE allowed** | **PUT blocked**, **DELETE allowed**, **POST allowed** | **PUT blocked**, **ADJUST allowed (no payments/credit notes)**, **VOID allowed (no payments/credit notes)** | **ADJUST blocked**, **VOID blocked** | immutable |
| Credit Note | PUT allowed, DELETE allowed | PUT blocked, DELETE allowed, POST allowed | PUT blocked, ADJUST allowed (non-inventory), VOID allowed | n/a | immutable |
| Expense | PUT allowed, DELETE allowed | PUT blocked, DELETE allowed, POST allowed | PUT blocked, ADJUST allowed (no payments), VOID allowed (no payments) | ADJUST/VOID blocked | immutable |
| Purchase Bill | PUT allowed, DELETE allowed | PUT blocked, DELETE allowed, POST allowed | PUT blocked, ADJUST allowed (non-inventory + no payments), VOID allowed (no payments) | ADJUST/VOID blocked | immutable |
| Journal Entry | n/a | n/a | **No edit/delete** → use **VOID** or **ADJUST** | n/a | n/a |

## Example flows (end-to-end)

### Edit Draft Invoice
- `PUT /companies/:companyId/invoices/:invoiceId` with the full draft payload
- No journal entry is created; invoice lines are replaced.

### Edit Posted Invoice (adjustment entry)
- `POST /companies/:companyId/invoices/:invoiceId/adjust`
- System creates (if needed) a new **adjustment JE** (and reverses any prior adjustment JE for that invoice).
- Invoice record is updated for UI consistency; original posting JE remains immutable.

### Delete Draft Expense
- `DELETE /companies/:companyId/expenses/:expenseId` with `Idempotency-Key`
- Deletes the expense row (no ledger impact).

### Void Posted Purchase Bill (reversal entry)
- `POST /companies/:companyId/purchase-bills/:purchaseBillId/void` with `Idempotency-Key`
- Creates a **reversal JE** of the original posting JE.
- Creates reversing **inventory stock moves** (if the bill posted inventory), using exact `totalCostApplied` to keep inventory valuation consistent.

## Tests checklist

### Unit tests (added)
- `test/reversal.service.test.ts`
  - `computeNetByAccount`
  - `diffNets`
  - `buildAdjustmentLinesFromNets` balance check

### Integration tests checklist (recommended)
- **Tenant isolation**: cannot access/void/adjust/delete across companies.
- **Idempotency**: retry `void/adjust/delete` with same `Idempotency-Key` returns same result, no duplicates.
- **Immutability**: posting JE lines never change; only new JEs are created.
- **Balancing**: adjustment JEs are always balanced (sum debit == sum credit).
- **Guards**:
  - invoice adjust blocked when payments exist
  - invoice void blocked when payments/posted credit notes exist
  - purchase bill void blocked when payments exist
  - purchase bill adjust blocked when inventory moves exist
- **Inventory correctness (void)**:
  - void invoice restores stock (IN) and links stock moves to void JE
  - void purchase bill reduces stock (OUT) using exact `totalCostApplied`
  - void credit note reduces stock (OUT) using exact `totalCostApplied`


