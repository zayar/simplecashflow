## Cashflow App — Architecture & System Flow (GCP base)

### Text architecture diagram (what runs where)

```
           (Browser / Mobile)
         Next.js UI / RN / Flutter
                 |
                 | HTTPS (JWT Bearer + Idempotency-Key on writes)
                 v
        Cloud Run: cashflow-api (Fastify)
                 |
                 | Prisma (MySQL)
                 v
            Cloud SQL (MySQL)
      (system of record + outbox table)
                 |
                 | Outbox rows: Event(publishedAt=null)
                 v
   Cloud Run: cashflow-publisher (poll + claim + retry)
                 |
                 | publishMessage(orderingKey=partitionKey=companyId)
                 v
            Pub/Sub Topic: cashflow-events
                 |
                 | Push subscription (OIDC-authenticated)
                 v
      Cloud Run: cashflow-worker (POST /pubsub/push)
                 |
                 | idempotent projection updates
                 v
            Cloud SQL (read models)
        DailySummary / AccountBalance / etc
```

### End-to-end request flow (typical write)

- **Client → API**
  - Sends `Authorization: Bearer <JWT>` and (for writes) `Idempotency-Key: <uuid>`.
  - Frontend auto-adds `Idempotency-Key` for non-GET requests (`frontend/src/lib/api.ts`).
- **API → DB transaction**
  - Validates tenant boundary via `JWT.companyId` (see **Multi-tenant rules** below).
  - Writes business data (e.g., Invoice/Payment/Expense/PurchaseBill).
  - Posts an immutable **double-entry** `JournalEntry` + `JournalLine` rows.
  - Inserts an outbox `Event` row in the same transaction.
- **API “fast path” publish (best-effort)**
  - Immediately calls Pub/Sub publish; if publish succeeds it marks `Event.publishedAt`.
  - If publish fails, it still returns success to client (the outbox publisher will retry).
- **Publisher → Pub/Sub (reliable path)**
  - Claims unpublished events using DB row locks + `SKIP LOCKED`.
  - Publishes with exponential backoff and writes retry metadata on the `Event` row.
- **Worker → projections**
  - Receives Pub/Sub push at `POST /pubsub/push`.
  - Verifies Google-signed OIDC token in production (audience + service account email).
  - Applies updates idempotently:
    - inserts `ProcessedEvent(eventId)` (unique) inside a DB transaction
    - updates `DailySummary` and `AccountBalance` for `journal.entry.created`

### Services/modules in this repo

- **Backend API**: `src/index.ts`
  - Modules:
    - `src/modules/auth/auth.routes.ts`: `/register`, `/login` (JWT)
    - `src/modules/companies/companies.routes.ts`: accounts, banking accounts, company settings
    - `src/modules/books/books.routes.ts`: customers, vendors, items, invoices, payments, bills/expenses, bill payments (AP)
    - `src/modules/ledger/ledger.routes.ts`: journal entries, reversals, period close, reports (trial balance, balance sheet, P&L, cashflow)
    - `src/modules/inventory/*`: warehouses, opening stock, adjustments, inventory reports
    - `src/modules/purchases/purchaseBills.routes.ts`: purchase bills with inventory receipt + AP payments
    - `src/modules/reports/apAging.routes.ts`: AP aging (expenses + purchase bills)
    - `src/modules/integrations/piti.routes.ts`: sample integration event → ledger posting
    - `src/modules/sequence/sequence.service.ts`: per-company document sequences (purchase bills)
- **Outbox publisher**: `src/publisher.ts`
- **Worker (Pub/Sub push receiver)**: `src/worker.ts`
- **Infrastructure helpers**: `src/infrastructure/*`
  - `db.ts`: Prisma + **immutable ledger middleware** (blocks updates/deletes to JournalEntry/JournalLine)
  - `commandIdempotency.ts`: HTTP idempotency via `IdempotentRequest(companyId,key)`
  - `idempotency.ts`: Pub/Sub idempotency via `ProcessedEvent(eventId)`
  - `locks.ts`: Redis distributed locks (`SET NX PX`) + best-effort mode
  - `pubsub.ts`: Pub/Sub publish wrapper (attributes + orderingKey)
  - `redis.ts`: Redis client singleton (best-effort)

### Multi-tenant rules (how tenant is enforced)

- **Source of truth**: `JWT.companyId` (set during `/register` and `/login`).
- **Route pattern**: almost all domain endpoints are `.../companies/:companyId/...`.
- **Guardrail**: `requireCompanyIdParam(request, reply)` ensures:
  - `:companyId` is numeric
  - `:companyId === JWT.companyId` (blocks cross-tenant access with 403)
- **Client-supplied companyId is rejected**: endpoints that accept `companyId` in the body use `forbidClientProvidedCompanyId(...)`.

### Key domain flows (what “matters” in this system)

#### Auth + company creation

- `POST /register`:
  - Creates `Company`, default Chart of Accounts, default warehouse, default banking cash account
  - Creates `User(companyId)`
  - Returns JWT containing `{ userId, email, companyId }`
- `POST /login`:
  - Returns JWT containing `{ userId, email, companyId }`

#### Ledger / journal posting (core financial correctness)

- Posting is done via `postJournalEntry(...)` (enforces: debit==credit, tenant-safe accounts, no negative amounts).
- Ledger is immutable:
  - `src/infrastructure/db.ts` blocks update/delete/upsert of `JournalEntry` and `JournalLine`.
  - Corrections happen via **reversal entries** and/or new entries.

#### Core CRUD (Books layer)

- Customers, vendors, items: standard CRUD (tenant-scoped).
- Invoices:
  - Create draft invoice → `POST /companies/:companyId/invoices`
  - Post invoice → `POST /companies/:companyId/invoices/:invoiceId/post`
    - Creates a `JournalEntry` and outbox events (`journal.entry.created`, `invoice.posted`)
    - If inventory tracked: applies WAC stock moves and posts COGS + Inventory credit
  - Record payment → `POST /companies/:companyId/invoices/:invoiceId/payments`
    - Creates JE (Dr bank/cash, Cr AR), updates `Invoice.amountPaid`, emits `journal.entry.created` and `payment.recorded`
  - Reverse payment → creates reversal JE + audit events (no deletes)

#### Inventory (WAC) and purchasing

- Opening stock balance: creates stock moves + JE (Dr Inventory / Cr Opening Equity).
- Adjustments: stock moves + JE with offset account.
- Purchase bills:
  - Draft: `POST /companies/:companyId/purchase-bills` (sequential `PB-000001`)
  - Post: receives inventory for tracked items + JE (Dr Inventory / Cr AP)
  - Pay: JE (Dr AP / Cr cash-bank)

#### Background jobs / workers

- Outbox publisher:
  - DB is the queue; Pub/Sub is delivery; idempotent consumers handle duplicates.
- Worker:
  - Updates read models for reporting (`DailySummary`, `AccountBalance`) off `journal.entry.created`.

#### Events (Pub/Sub) and consumers

- Topic: `cashflow-events`
- Attributes include: `eventId`, `eventType`, `companyId`, `schemaVersion`, `correlationId`, `aggregateType`, `aggregateId`.
- Ordering: `orderingKey = partitionKey = companyId` (per-tenant ordering).
- Push subscription uses OIDC tokens and Cloud Run Invoker IAM.

### What is already production-grade vs. what is missing/risky

#### Production-grade (keep this base!)

- **Double-entry correctness** enforced centrally (posting engine).
- **Immutability**: strong guardrail at Prisma middleware level.
- **Idempotency**:
  - HTTP writes: `Idempotency-Key` → `IdempotentRequest` stored response replay
  - Pub/Sub: `ProcessedEvent` (unique) + optional Redis in-flight guard
- **Distributed locking** for “money actions” (Redis) with best-effort degradation.
- **Outbox pattern**: DB as durable event source; publisher with retry/backoff.
- **Pub/Sub push auth**: OIDC verification support in worker.

#### Missing / risky / “next hardening steps”

- **Env separation**: deploy script is single-project oriented; no explicit dev/staging/prod config model.
- **IaC**: no Terraform/Pulumi; infra changes are script/manual-driven.
- **Artifact Registry**: build uses `gcr.io` (Container Registry). Consider migrating to Artifact Registry.
- **Observability**: no explicit metrics dashboards/alerts; tracing not configured.
- **Frontend security**: token stored in JS-accessible cookies (XSS risk); consider HttpOnly cookie or short-lived tokens + refresh.
- **Testing**: backend has no unit/integration test runner wired; frontend ignores TS/ESLint during build.
- **Secrets & DB access**:
  - `deploy/deploy_gcp.sh` uses `root` and prompts for DB password; ensure least privilege in production.
  - Cloud SQL public IP is referenced; prefer private IP + VPC connector when you harden.
- **Analytics**: no BigQuery pipeline currently (can be added as a consumer).

### Open questions (to finalize the onboarding pack)

- What are the **dev/staging/prod** GCP project IDs and the desired separation model?
- Do you want an **API gateway / load balancer** in front of Cloud Run (Cloud Load Balancer + Cloud Armor)?
- Is Redis (Memorystore) actually provisioned in GCP for prod, and what is the `REDIS_URL` strategy?
- Do you plan to use **BigQuery** now (events → analytics), or later?


