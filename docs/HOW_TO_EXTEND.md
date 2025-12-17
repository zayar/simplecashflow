## How to extend this system safely (without rewrites)

### Golden rules (non-negotiable)

- **Tenant boundary is sacred**
  - Tenant = `JWT.companyId`.
  - Every DB query for tenant-owned tables must include `companyId` in the `where`.
- **Ledger is immutable**
  - Never update/delete `JournalEntry` or `JournalLine`.
  - If something must be “undone,” create a reversal entry and record audit metadata.
- **All high-risk writes must be idempotent**
  - Require `Idempotency-Key` and use `runIdempotentRequest(...)`.
- **Concurrency must be safe across Cloud Run instances**
  - Use Redis locks (`withLockBestEffort` / `withLocksBestEffort`) for posting, payments, stock moves.
- **Events are not “nice to have”**
  - If a change affects reporting/projections/integrations, insert an outbox `Event` row in the same DB transaction.
  - Consumers must be idempotent.

### Where to add features (folder map)

- **New API routes**: `src/modules/<domain>/<domain>.routes.ts`
- **Core domain services**: `src/modules/<domain>/*.service.ts`
- **Shared infrastructure**:
  - DB: `src/infrastructure/db.ts`
  - Idempotency: `src/infrastructure/commandIdempotency.ts`
  - Locks: `src/infrastructure/locks.ts`
  - Pub/Sub: `src/infrastructure/pubsub.ts`
- **Worker consumers/projections**: `src/worker.ts`
- **Frontend API wrapper**: `frontend/src/lib/api.ts` (adds auth + idempotency headers)

### How to add a new module/route

1. Create `src/modules/<domain>/<domain>.routes.ts` exporting `async function <domain>Routes(fastify)`.
2. Add `fastify.addHook('preHandler', fastify.authenticate)` if it’s authenticated.
3. Use tenant helpers:
   - If route has `:companyId`: `const companyId = requireCompanyIdParam(request, reply);`
   - If request body may contain companyId: forbid it via `forbidClientProvidedCompanyId(...)`
4. Register the module in `src/index.ts`.

### How to add a new write endpoint safely (template)

Use this order every time:

- **(A) Tenant id**
  - `companyId = requireCompanyIdParam(...)` or `forbidClientProvidedCompanyId(...)`
- **(B) Idempotency**
  - Require `Idempotency-Key` header
  - Wrap the whole action in `runIdempotentRequest(prisma, companyId, key, async () => { ... }, redis)`
- **(C) Locks (if money/inventory)**
  - `withLockBestEffort(redis, lockKey, ttlMs, async () => ...)`
  - Use `withLocksBestEffort` for multiple stock keys (`companyId+warehouseId+itemId`)
- **(D) DB transaction**
  - `await prisma.$transaction(async (tx) => { ... })`
  - Write business row(s)
  - If ledger impact: call `postJournalEntry(tx, ...)`
  - Insert outbox `Event` row(s) in the same transaction
- **(E) Publish (optional fast path)**
  - After idempotent block returns, if not replay: call `publishDomainEvent(...)` and `markEventPublished(...)`
  - Always rely on outbox publisher for eventual delivery

### How to add a new DB table + migrations

- Update `prisma/schema.prisma`
- Create migration:

```bash
npx prisma migrate dev --name <short_name>
```

- For prod deploys:
  - `deploy/deploy_gcp.sh` runs `prisma migrate deploy` against Cloud SQL via Cloud SQL Proxy.

**Schema ownership guideline**

- If a table is tenant-owned, it must include `companyId` and be queried with `where: { companyId, ... }`.
- Add compound unique constraints per tenant when needed (`@@unique([companyId, ...])`).

### How to add a new event type

When you make a business change you want to “broadcast”:

- Pick an `eventType` like `invoice.posted`, `payment.recorded`, `inventory.adjusted`.
- Insert into the outbox table (`Event`) inside the DB transaction:
  - `eventId` should be UUID
  - `partitionKey` should be `String(companyId)` for per-tenant ordering
  - `correlationId` should be stable for the whole user workflow (one UUID per action)
  - `aggregateType` / `aggregateId` identify the object
- Optionally publish immediately (fast path), but do not make correctness depend on it.

### How to add a new worker consumer/projection

- Update `src/worker.ts`:
  - Parse Pub/Sub push payload → domain event envelope
  - For each event you handle:
    - call `runIdempotent(prisma, companyId, eventId, async (tx) => { ... }, redis)`
    - write projections (new read model tables) inside that transaction
- Keep consumer logic:
  - **idempotent**
  - **tenant-scoped**
  - **non-throwing on malformed messages** (otherwise Pub/Sub retries forever)

### Coding conventions that matter here

- **Do not bypass `postJournalEntry`** for postings.
- **Never add “update ledger rows” endpoints**; use reversals.
- **Use Decimal math for money** (Prisma.Decimal), not float arithmetic.
- **Idempotency is part of the API contract** for posting/payment/reversal operations.
- **Lock keys must be deterministic**:
  - invoice posting: `lock:invoice:post:<companyId>:<invoiceId>`
  - payment: `lock:invoice:payment:<companyId>:<invoiceId>`
  - stock: `lock:stock:<companyId>:<warehouseId>:<itemId>`

### Definition of Done (for features)

- **Correctness**
  - Tenant boundary enforced
  - Idempotency implemented for writes
  - Locks used for concurrency-sensitive operations
  - Events written to outbox where relevant
- **Docs**
  - `docs/API_GUIDE.md` updated with endpoint + invariants
- **Operational**
  - Works on Cloud Run with multiple instances (no in-memory coordination assumptions)


