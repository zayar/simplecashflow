## Developer Presentation (12–15 slides) — paste into Google Slides

### Slide 1 — Vision + Why we keep this base

- **Vision**: production-grade cashflow + bookkeeping with fintech safety rails baked in.
- **Why keep this base**:
  - Tenant enforcement is consistent and centralized.
  - Ledger immutability prevents “silent corruption.”
  - Idempotency + locks make Cloud Run retries safe.
  - Outbox + Pub/Sub gives scalable async processing without losing events.
- **Message to the team**: we extend this base; we don’t delete it.

### Slide 2 — System overview (1 diagram)

- Components:
  - Next.js frontend / mobile clients
  - Cloud Run: API, publisher, worker
  - Cloud SQL (MySQL)
  - Pub/Sub
  - Redis (locks/idempotency fast-path)
- Data flow: API writes → outbox → publisher → Pub/Sub → worker → projections

### Slide 3 — Services/modules and responsibilities

- **`cashflow-api`**
  - Auth, tenant-scoped CRUD, posting engine integration, outbox writes
- **`cashflow-publisher`**
  - Reliable outbox delivery with retry/backoff and row-claiming
- **`cashflow-worker`**
  - Pub/Sub push receiver; idempotent projection updates
- **Frontend**
  - JWT session + automatic idempotency keys on writes

### Slide 4 — Request lifecycle (frontend/mobile → backend → DB → events)

- Client sends:
  - `Authorization: Bearer <JWT>`
  - `Idempotency-Key: <uuid>` (writes)
- API:
  - validates tenant
  - writes business row(s) + immutable JE/JL
  - inserts outbox `Event`
  - optional fast-path publish
- Publisher:
  - eventually publishes all outbox events
- Worker:
  - idempotently updates read models

### Slide 5 — Multi-tenant rules (how tenant is enforced)

- Token includes `companyId`
- Route guard:
  - `requireCompanyIdParam(...)` enforces `:companyId === JWT.companyId`
- Query rule:
  - every tenant-owned query includes `where: { companyId, ... }`
- Anti-pattern:
  - never trust `companyId` from request body

### Slide 6 — Data model overview (key tables/entities)

- **Core**:
  - `Company`, `User`
- **Ledger**:
  - `Account`, `JournalEntry`, `JournalLine`
- **Books layer**:
  - `Customer`, `Item`, `Invoice`, `Payment`, `Expense`, `Vendor`
- **Inventory**:
  - `Warehouse`, `StockBalance`, `StockMove`
- **Purchasing**:
  - `PurchaseBill`, `PurchaseBillLine`, `PurchaseBillPayment`
- **Outbox + idempotency**:
  - `Event`, `ProcessedEvent`, `IdempotentRequest`
- **Read models**:
  - `DailySummary`, `AccountBalance`

### Slide 7 — Event-driven pieces (Pub/Sub, consumers, idempotency)

- Pattern: **Outbox table** + **publisher** + **Pub/Sub** + **idempotent worker**
- Ordering: `orderingKey = companyId` (per-tenant ordering)
- Worker safety:
  - OIDC verification for push auth
  - `ProcessedEvent(eventId)` uniqueness prevents duplicates
- Publisher safety:
  - DB row claiming (`SKIP LOCKED`), retry metadata, exponential backoff

### Slide 8 — API standards (auth, error format, versioning)

- Auth: JWT Bearer
- Writes:
  - require `Idempotency-Key` for posting/payment/reversal/close flows
- Errors:
  - `{ error: "message" }` (current)
- Versioning:
  - event envelopes include `schemaVersion` (`v1`)
  - HTTP API versioning is not introduced yet (open decision)

### Slide 9 — Local dev setup (run services, env vars, seed)

- Start MySQL via Docker Compose
- `.env` for `DATABASE_URL`, `JWT_SECRET`, optional `REDIS_URL`
- Prisma migrate
- Run:
  - API (`npm run dev`)
  - optional worker/publisher on separate ports
- Seed path:
  - register via API (`/register`) to bootstrap company + accounts

### Slide 10 — Deploy flow (Cloud Build → Cloud Run + migrations)

- Cloud Build builds/pushes images:
  - API, publisher, worker, frontend
- Deploy script:
  - runs Prisma migrations via Cloud SQL Proxy
  - stores `DATABASE_URL` in Secret Manager
  - deploys Cloud Run services (invoker restrictions for worker)
  - recreates Pub/Sub push subscription with message ordering + OIDC auth

### Slide 11 — Observability + debugging checklist

- Cloud Run logs:
  - API: request logs + errors
  - Publisher: publish failures + lockId + attempts
  - Worker: received envelope + idempotency skips + projection updates
- Debug checklist:
  - Confirm `companyId` matches token
  - Confirm `Idempotency-Key` present on writes
  - Check `Event` outbox rows (publishedAt/attempts/lastPublishError)
  - Confirm Pub/Sub push auth (audience + service account email)

### Slide 12 — How to extend without rewrite (golden rules)

- No cross-tenant reads/writes
- No ledger edits; use reversals
- Idempotency for writes
- Locks for money/inventory actions
- Outbox events for async consistency
- Worker consumers must be idempotent

### Slide 13 — Current gaps + next 2-week plan

- Gaps (today):
  - no IaC, no tests, limited observability, cookie token security risk, env separation not formalized
- 2-week plan (suggested):
  - Add CI checks + minimal integration tests (posting + idempotency)
  - Add dashboards/alerts (Cloud Run error rate, Pub/Sub backlog, Cloud SQL CPU)
  - Formalize dev/staging/prod config + service accounts
  - Decide token storage model (HttpOnly cookie vs. mobile token strategy)

### Slide 14 — Q&A + ownership map (who owns what)

- Owners:
  - API + schema + posting engine: Backend team
  - Publisher/worker + Pub/Sub + migrations: Platform/Cloud team
  - UI + client idempotency: Frontend team
  - Mobile: Mobile team
- Decision log:
  - any change impacting safety rails requires review (tenant/idempotency/ledger)


