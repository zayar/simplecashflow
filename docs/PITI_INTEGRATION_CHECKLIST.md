## Piti → Cashflow Integration Checklist (hand this to Piti team)

### Production base URL (current)

- `https://cashflow-api-291129507535.asia-southeast1.run.app`

### Required headers

- **Auth**: `X-Integration-Key: <secret>` (Cashflow env: `PITI_INTEGRATION_API_KEY`)
- **Idempotency**: `Idempotency-Key: <stable unique key>`
- **Content-Type**: `application/json`

### Idempotency rules (must follow)

- **One user action = one idempotency key**
  - Sale completion: `piti:sale:<saleId>:completed`
  - Refund: `piti:refund:<refundId>`
- **Retry with the same Idempotency-Key** if the network fails/timeouts.
- Cashflow stores the response in DB (`IdempotentRequest`) and will replay it.

### Retry rules (recommended)

- Retry only on **network errors / 5xx / 429**.
- Exponential backoff example:
  - 1s → 2s → 4s → 8s → 16s (cap at ~60s), then alert/human review.
- Do **not** retry on **4xx** (payload bug) except **429**.

### External ID mapping (what Cashflow will do)

Cashflow stores a mapping table so duplicates never happen:
- `Sale (saleId) -> Invoice (invoiceId)`
- `Refund (refundId) -> CreditNote (creditNoteId)`
- `Customer (externalCustomerId) -> Customer (customerId)`
- `Item (externalProductId) -> Item (itemId)`

### Inventory rule (critical)

- Piti is operational inventory SoT.
- Cashflow will create/reuse items for reporting, but will set:
  - **`trackInventory=false`**
- So Piti must still be the place that decrements/restocks stock quantities.

### Endpoints

- **Sale completed → invoice + JE (+ optional payment)**:
  - `POST /integrations/piti/companies/:companyId/sales`
- **Refund/return → credit note + JE**:
  - `POST /integrations/piti/companies/:companyId/refunds`


