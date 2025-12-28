# Cashflow App — Architecture Handover (Presentation)

Use this as a **slide deck in Markdown**. Copy each `---` section into Google Slides.

---

## Slide 1 — What we built (and why it’s safe to extend)

- **Product**: multi-tenant bookkeeping + cashflow (double-entry accounting)
- **Key safety rails** (fintech-grade):
  - **Tenant enforcement** (JWT `companyId`)
  - **Ledger immutability** (no edits/deletes; use reversals)
  - **Idempotency** (HTTP + Pub/Sub) for Cloud Run retries
  - **Distributed locks** (Redis best-effort) for money/inventory actions
  - **Outbox + Pub/Sub** for reliable async processing

> Speaker notes: The most important message for future development is: keep the safety rails. Most bugs in accounting systems come from cross-tenant leakage, mutable ledgers, and non-idempotent “posting” endpoints.

---

## Slide 2 — High-level architecture (what runs where)

- **Clients**: Next.js web (`frontend/`) + Mobile PWA (`mobile-pwa/`)
- **Backend services** (Cloud Run):
  - `cashflow-api` (Fastify)
  - `cashflow-publisher` (outbox → Pub/Sub)
  - `cashflow-worker` (Pub/Sub push receiver → projections)
- **Data / infra**:
  - Cloud SQL (MySQL) — system of record
  - Pub/Sub — event delivery
  - Redis (Memorystore) — locks + idempotency fast path (best-effort)

> Speaker notes: API is the only service clients talk to. Publisher + worker are internal services to keep reporting/read models consistent and scalable.

---

## Slide 3 — Text diagram (end-to-end)

```
Browser / Mobile
  |
  | HTTPS (JWT + Idempotency-Key on writes)
  v
Cloud Run: cashflow-api (Fastify)
  |
  | Prisma (MySQL)
  v
Cloud SQL (system of record + outbox Event table)
  |
  | unpublished Event rows
  v
Cloud Run: cashflow-publisher (poll + claim + retry)
  |
  v
Pub/Sub Topic: cashflow-events (orderingKey=companyId)
  |
  | Push subscription (OIDC auth)
  v
Cloud Run: cashflow-worker (POST /pubsub/push)
  |
  v
Cloud SQL (projections): DailySummary, AccountBalance, ...
```

> Speaker notes: This is an outbox pattern. DB is the durable queue. Pub/Sub is delivery. Worker is idempotent, so duplicates are safe.

---

## Slide 4 — Backend entrypoints (3 runtimes)

- **API**: `src/index.ts`
  - Registers domain routes (auth, books, ledger, inventory, purchases, reports, taxes, integrations)
  - Installs JWT + CORS + rate limiter
  - Installs **tenant context** after auth (`runWithTenant(companyId, ...)`)
- **Publisher**: `src/publisher.ts`
- **Worker**: `src/worker.ts`

> Speaker notes: Even though they share a repo, treat them as separate processes/services.

---

## Slide 5 — Domain modules (how code is organized)

- **Auth**: `src/modules/auth/*`
- **Companies/settings/accounts**: `src/modules/companies/*`
- **Books (AR/AP docs)**: `src/modules/books/*`
  - customers, vendors, items, invoices, payments, expenses, credit notes
- **Ledger**: `src/modules/ledger/*` (posting engine, reversals, period close, reports)
- **Inventory**: `src/modules/inventory/*` (WAC valuation, stock moves/balances)
- **Purchases**: `src/modules/purchases/*` (purchase bills + payments)
- **Reports**: `src/modules/reports/*` (trial balance, P&L, etc.)
- **Taxes**: `src/modules/taxes/*`
- **Integrations**: `src/modules/integrations/*` (e.g., Piti)

> Speaker notes: Route files should stay “thin” (validate + orchestration). Keep business invariants in services/helpers and reuse from tests where possible.

---

## Slide 6 — Tenant model (non-negotiable)

- **Tenant source of truth**: JWT includes `companyId`
- **Typical route shape**: `/companies/:companyId/...`
- **Guardrail**:
  - validate `:companyId` is numeric
  - enforce `:companyId === JWT.companyId` (deny cross-tenant access)
- **Rule**: never trust `companyId` in request body

> Speaker notes: Almost every data bug becomes catastrophic if tenant boundary is weak. This is the single most important invariant.

---

## Slide 7 — Ledger model (what makes accounting correct)

- Double-entry ledger:
  - `JournalEntry` (header) + `JournalLine` (debit/credit lines)
- **Must balance**: total debit == total credit
- Ledger is **immutable**:
  - no updates/deletes to `JournalEntry` / `JournalLine`
  - corrections are done by **reversal entries** and new postings

> Speaker notes: This is why “edit posted invoice” is implemented as adjustment/reversal, not mutation. That keeps audits and reports trustworthy.

---

## Slide 8 — Idempotency (HTTP) (Cloud Run safe writes)

- For money/inventory actions, clients send `Idempotency-Key`
- Backend stores/replays responses using `IdempotentRequest(companyId, key)`
- Result: user double-click / network retries do **not** create duplicates

> Speaker notes: Any endpoint that posts/records payments/reverses/closes periods should treat idempotency as part of its contract.

---

## Slide 9 — Locks (Redis, best-effort)

- Some actions must not run concurrently across instances:
  - invoice posting
  - invoice payments
  - stock moves / adjustments
- Redis lock pattern (best-effort):
  - `SET NX PX` with deterministic lock keys
  - if Redis is down, code is designed to degrade (with careful idempotency)

> Speaker notes: Locks reduce race conditions. Idempotency makes them survivable. Together they make Cloud Run scaling safe.

---

## Slide 10 — Events & outbox (why we have publisher + worker)

- Transaction writes:
  - business rows + ledger rows
  - **outbox `Event` row** in the same DB transaction
- Publisher ensures eventual delivery to Pub/Sub:
  - claims unpublished events
  - retries/backoff
- Worker updates projections:
  - uses `ProcessedEvent(eventId)` uniqueness to skip duplicates

> Speaker notes: This decouples “write path” from “read model/reporting path” while staying reliable.

---

## Slide 11 — Key database tables (what your team should know)

- **Core**: `Company`, `User`
- **Ledger**: `Account`, `JournalEntry`, `JournalLine`
- **Outbox/events**: `Event`, `ProcessedEvent`
- **HTTP idempotency**: `IdempotentRequest`
- **Read models**: `DailySummary`, `AccountBalance`
- **Inventory**: `Warehouse`, `StockBalance`, `StockMove`
- **AR/AP docs**: `Invoice`, `InvoiceLine`, `Payment`, `Expense`, `PurchaseBill`, ...
- **Tax**: `TaxRate`, `TaxGroup`, `TaxGroupMember`
- **Integrations**: `IntegrationEntityMap`

> Speaker notes: Use schema as documentation. Tenant-owned tables include `companyId` and must be queried with it.

---

## Slide 12 — Deployment shape (GCP)

- Build & deploy assets: `deploy/`
  - Cloud Build configs: `deploy/cloudbuild.*.yaml`
  - Dockerfiles: `deploy/Dockerfile*`
  - Deploy script: `deploy/deploy_gcp.sh`
- Deploy flow:
  - build images
  - run Prisma migrations against Cloud SQL (via Cloud SQL Proxy)
  - deploy Cloud Run services (API/worker/publisher)
  - create Pub/Sub push subscription → worker `/pubsub/push` (OIDC auth)

> Speaker notes: The most common production issue is misconfigured Pub/Sub push auth (audience/SA email/IAM).

---

## Slide 13 — Local dev workflow (how to run it)

- Backend:
  - `npm install`
  - MySQL: `docker compose -f deploy/docker-compose.yml up -d`
  - Prisma: `npx prisma generate && npx prisma migrate dev`
  - Run API: `npm run dev`
- Frontend:
  - `cd frontend && npm install`
  - set `NEXT_PUBLIC_API_URL=http://localhost:8080`
  - run `npm run dev`

> Speaker notes: Full local loop for publisher/worker is optional; API + DB is enough for most feature development.

---

## Slide 14 — How to extend safely (definition of done)

- **Tenant safety** enforced
- **Idempotency** on high-risk writes
- **Locks** for concurrency-sensitive operations
- **Ledger invariants**: use posting engine + reversals (no edits)
- **Events**: insert outbox rows for cross-cutting changes
- **Docs**: update `docs/API_GUIDE.md` if you change APIs

> Speaker notes: Treat these as required checkboxes in PR reviews.

---

## Slide 15 — “Where bugs hide” checklist

- Missing/incorrect `companyId` checks
- Non-idempotent writes (duplicates on retry)
- Updating posted ledger/doc rows instead of reversal/adjustment
- Inventory race conditions (double posting / negative stock)
- Worker not idempotent (Pub/Sub retries create double projections)
- Currency/rounding differences between UI and backend

> Speaker notes: Use this slide during code review training. Most real incidents map to one of these.


