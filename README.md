# Cashflow App

Full‑stack cashflow / bookkeeping app with:

- **API** (Fastify + TypeScript) for auth, companies, ledger, and “books” (customers, items, invoices, payments, expenses)
- **Outbox publisher** that publishes DB `Event` rows to **Google Pub/Sub** with retry + locking
- **Worker** that consumes Pub/Sub push messages and updates derived read models (e.g. `DailySummary`) **idempotently**
- **Frontend** (Next.js + Tailwind) that talks to the API using JWT

## Start here (developer onboarding)

- **Architecture + system flow**: `docs/ARCHITECTURE.md`
- **API usage guide + standards**: `docs/API_GUIDE.md`
- **How to run locally (backend + DB + frontend)**: `docs/RUN_LOCAL.md`
- **How to extend safely (no rewrites)**: `docs/HOW_TO_EXTEND.md`
- **Rewrite policy**: `docs/REWRITE_POLICY.md`
- **Developer presentation (slide bullets)**: `docs/DEVELOPER_PRESENTATION.md`

## Architecture (high level)

This repo follows an **Outbox + Pub/Sub** pattern:

- **API (`src/index.ts`)** writes business data and also appends an `Event` row (the outbox).
- **Publisher (`src/publisher.ts`)** claims unpublished outbox rows, publishes them to Pub/Sub, and marks them published (with retries/backoff).
- **Worker (`src/worker.ts`)** receives Pub/Sub push deliveries at `POST /pubsub/push` and updates projections using **idempotency** (`ProcessedEvent`).

Key tables are in `prisma/schema.prisma`:

- **Ledger**: `Company`, `Account`, `JournalEntry`, `JournalLine`
- **Outbox / events**: `Event` (publishedAt, attempts, locks), `ProcessedEvent`
- **Read model**: `DailySummary`
- **Books**: `Customer`, `Item`, `Invoice`, `Payment`, `Expense`
- **Auth**: `User`
- **HTTP idempotency**: `IdempotentRequest`

## Tech stack

- **Backend**: Node.js (ESM) + TypeScript + Fastify
- **DB**: MySQL + Prisma
- **Messaging**: Google Pub/Sub
- **Cache/Locks/Idempotency**: Redis (Memorystore on GCP)
- **Frontend**: Next.js (App Router) + TailwindCSS

## Fintech safety rails (important)

This project is designed with production-grade accounting rules:

- **Double-entry correctness**: every posting creates balanced `JournalLine` rows (total debit == total credit).
- **Immutability**: posted ledger entries are immutable (no edits; use reversals/adjustments).
- **Idempotency**:
  - HTTP writes use `Idempotency-Key` (stored in `IdempotentRequest`) to prevent duplicates under retries.
  - Pub/Sub deliveries are idempotent via `ProcessedEvent` (and Redis short-circuit when available).
- **Distributed locks (Redis)**: high-risk “money actions” are protected by locks to prevent double-click / concurrency across multiple Cloud Run instances:
  - invoice post, payment record, payment reverse, journal entry reverse.

## Requirements

- Node.js **22+**
- Docker (for local MySQL) + Docker Compose
- (Optional) Google Cloud SDK (`gcloud`) for deployment

## Local setup (backend + database)

### 1) Install backend deps

```bash
cd /Users/zayarmin/Development/cashflow-app
npm install
```

### 2) Start MySQL locally (Docker)

```bash
docker compose -f deploy/docker-compose.yml up -d
```

This starts:

- MySQL on `localhost:3306` (db: `cashflow_dev`)
- Adminer on `http://localhost:8080`

### 3) Configure environment

Create `.env` in the repo root:

```bash
cat > .env <<'EOF'
# Local MySQL (docker-compose)
DATABASE_URL="mysql://cashflow_user:cashflow_pass@localhost:3306/cashflow_dev"

# Optional (API JWT signing)
JWT_SECRET="dev-secret"

# Optional (used by publisher when publishing to Pub/Sub)
PUBSUB_TOPIC="cashflow-events"

# Optional (Redis for caching/locks/idempotency)
REDIS_URL="redis://127.0.0.1:6379"
EOF
```

### 4) Apply migrations + generate Prisma client

```bash
npx prisma generate
npx prisma migrate dev
```

## Run locally (dev)

Open 3 terminals from the repo root:

### API

```bash
npm run dev
```

- Runs on `http://localhost:8080`
- Health: `GET /health`

### Worker (Pub/Sub push receiver)

```bash
npm run worker
```

- Listens on `http://localhost:8080/pubsub/push` by default (set `PORT` if you want a different port)

### Publisher (outbox → Pub/Sub)

```bash
npm run publisher
```

Publisher env options:

- `PUBLISH_INTERVAL_MS` (default `1000`)
- `PUBLISH_BATCH_SIZE` (default `50`)
- `LOCK_TIMEOUT_MS` (default `60000`)

> Note: Local Pub/Sub publishing requires GCP credentials configured for `@google-cloud/pubsub`. If you only want to run API + DB locally, you can skip `publisher` and `worker`.

## Frontend (Next.js)

### 1) Install deps

```bash
cd /Users/zayarmin/Development/cashflow-app/frontend
npm install
```

### 2) Configure API URL

Create `frontend/.env.local`:

```bash
cat > .env.local <<'EOF'
NEXT_PUBLIC_API_URL="http://localhost:8080"
EOF
```

### 3) Run

```bash
npm run dev
```

## Quick functional flow

- Register a user: `POST /register` (creates a company + default accounts)
- Login: `POST /login` → JWT token
- Use the token as `Authorization: Bearer <token>` for authenticated endpoints

## Testing & scripts

Useful scripts live in `scripts/` and docs in `docs/`:

- `docs/TESTING_GUIDE.md`: manual idempotency testing steps
- `scripts/test_idempotency.sh`, `scripts/test_duplicate.sh`: idempotency checks
- `scripts/e2e_test.sh`, `scripts/e2e_test_robust.sh`: end-to-end flows

## Deployment (GCP)

Deployment assets are in `deploy/`.

- Dockerfiles:
  - `deploy/Dockerfile` (API)
  - `deploy/Dockerfile.worker`
  - `deploy/Dockerfile.publisher`
- Cloud Build configs:
  - `deploy/cloudbuild.api.yaml`
  - `deploy/cloudbuild.worker.yaml`
  - `deploy/cloudbuild.publisher.yaml`
- Script: `deploy/deploy_gcp.sh`

The deploy script:

- Builds container images via Cloud Build
- Runs Prisma migrations against Cloud SQL via Cloud SQL Proxy
- Creates/updates a Secret Manager secret for `DATABASE_URL`
- Deploys Cloud Run services (API, worker, publisher)
- Recreates a Pub/Sub push subscription to point at the worker `/pubsub/push` endpoint (with message ordering)

### Pub/Sub push auth (OIDC) checklist

The worker endpoint `POST /pubsub/push` requires a Google-signed OIDC token from Pub/Sub push.

Cloud Run `cashflow-worker` env vars:

- `PUBSUB_PUSH_AUDIENCE`: set to the full push URL, e.g. `https://<worker>.run.app/pubsub/push`
- `PUBSUB_PUSH_SA_EMAIL`: service account email used by the subscription push auth
- `ENFORCE_PUBSUB_OIDC_AUTH=true`

Pub/Sub subscription (`cashflow-events-worker`) push config:

- Push endpoint: `https://<worker>.run.app/pubsub/push`
- Authentication: OIDC token using the same service account
- Audience: same as `PUBSUB_PUSH_AUDIENCE`

Cloud Run IAM:

- Grant the push service account **Cloud Run Invoker** on `cashflow-worker`.

## Troubleshooting

- **Prisma / OpenSSL**: Docker images install OpenSSL (required by Prisma).
- **Port conflicts**: API/worker/publisher default to `PORT=8080`. Run them on different ports locally by setting `PORT` per process.
- **Pub/Sub locally**: if `publisher` fails with auth errors, run `gcloud auth application-default login` or configure a service account via `GOOGLE_APPLICATION_CREDENTIALS`.
- **Idempotency-Key required**: for posting endpoints, always send `Idempotency-Key` to prevent duplicates (frontend auto-adds this for non-GET requests).

## License

TBD



