## How to run locally (backend + DB + frontend)

### Prerequisites

- **Node.js**: 22+
- **Docker + Docker Compose**: for local MySQL
- **Optional**: Redis (recommended) for locks/idempotency fast-path
- **Optional (for Pub/Sub publishing locally)**: Google Cloud SDK + Application Default Credentials

### Repo structure (what you will run)

- **API**: `npm run dev` (Fastify)
- **Worker** (Pub/Sub push receiver): `npm run worker`
- **Publisher** (outbox → Pub/Sub): `npm run publisher`
- **Frontend**: `frontend/` (Next.js)

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

# API JWT signing (dev only)
JWT_SECRET="dev-secret"

# Pub/Sub topic name (used by publisher and the API fast-path publish)
PUBSUB_TOPIC="cashflow-events"

# Redis for locks/idempotency (recommended)
REDIS_URL="redis://127.0.0.1:6379"

# Worker: bypass Pub/Sub OIDC in local dev (recommended)
DISABLE_PUBSUB_OIDC_AUTH="true"
EOF
```

> Note: if you do not run Redis locally, set `REDIS_URL` anyway or omit it; Redis is **best-effort** in this codebase.

### 4) Prisma: generate + migrate

```bash
npx prisma generate
npx prisma migrate dev
```

### 5) Run the backend processes

#### Option A (minimal): API only

```bash
npm run dev
```

- API runs on `http://localhost:8080`
- Health: `GET /health`

#### Option B (full local loop): API + worker + publisher

Because all three default to `PORT=8080`, run them on different ports:

Terminal 1:

```bash
PORT=8080 npm run dev
```

Terminal 2:

```bash
PORT=8081 npm run worker
```

Terminal 3:

```bash
PORT=8082 npm run publisher
```

Worker endpoint (local): `POST http://localhost:8081/pubsub/push`

> Pub/Sub push is a GCP-managed feature; locally you won’t have a real push subscription unless you emulate it. For local dev, you can still run API + DB and skip publisher/worker, or manually POST a Pub/Sub payload to the worker.

### 6) Run the frontend (Next.js)

```bash
cd /Users/zayarmin/Development/cashflow-app/frontend
npm install
```

Create `frontend/.env.local`:

```bash
cat > .env.local <<'EOF'
NEXT_PUBLIC_API_URL="http://localhost:8080"
EOF
```

Run:

```bash
npm run dev
```

### 7) Quick sanity flow (API)

Register:

```bash
curl -sS -X POST 'http://localhost:8080/register' \
  -H 'Content-Type: application/json' \
  -d '{"email":"dev@example.com","password":"pass1234","companyName":"Acme Co","name":"Dev"}'
```

Login:

```bash
curl -sS -X POST 'http://localhost:8080/login' \
  -H 'Content-Type: application/json' \
  -d '{"email":"dev@example.com","password":"pass1234"}'
```

### Common issues

- **Ports conflict**: API/worker/publisher default to `PORT=8080`. Set a different `PORT` per process.
- **Publisher fails locally (GCP auth)**:
  - Run `gcloud auth application-default login`, or set `GOOGLE_APPLICATION_CREDENTIALS` to a service account JSON file.
- **Prisma / OpenSSL in Docker images**:
  - The provided Dockerfiles install OpenSSL; locally (non-container) this is rarely an issue.
- **Write endpoints failing with “Idempotency-Key header is required”**:
  - Generate a UUID and send `Idempotency-Key` for posting/payment/reversal/close calls.

### Cloud SQL Proxy (production/staging DB access from your laptop)

When you need to run Prisma commands against Cloud SQL (production/staging), you typically connect through **Cloud SQL Auth Proxy**.

Important beginner note:
- If you paste commands into `zsh`, do **not** paste comment lines that start with `#` (zsh will treat it like a command if you paste it alone).

#### Option A: You already have `cloud-sql-proxy` installed (recommended)

Check:

```bash
command -v cloud-sql-proxy
```

If it prints a path (example: `/usr/local/bin/cloud-sql-proxy`), start the proxy:

```bash
cloud-sql-proxy --address 127.0.0.1 --port 3307 "aiaccount-1c845:asia-southeast1:cashflow-mysql"
```

Leave it running in that terminal.

#### Option B: Use the repo-local proxy binary (what `deploy/deploy_gcp.sh` does)

From repo root:

```bash
cd /Users/zayarmin/Development/cashflow-app
./deploy/deploy_gcp.sh
```

During deploy, the script will:
- download `cloud-sql-proxy` into the repo (if missing)
- start it on `127.0.0.1:3307`
- run `prisma migrate deploy`

#### Running Prisma “resolve” with the proxy

Open a new terminal while proxy is running and execute:

```bash
cd /Users/zayarmin/Development/cashflow-app
export DATABASE_URL="mysql://root:<PASSWORD_URLENCODED>@127.0.0.1:3307/cashflow_prod"
npx prisma migrate resolve --rolled-back <migration-name>
```


