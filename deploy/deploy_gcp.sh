#!/usr/bin/env bash
set -euo pipefail

# ---- Config (edit if needed) ----
PROJECT_ID="aiaccount-1c845"
REGION="asia-southeast1"
INSTANCE_CONN="aiaccount-1c845:asia-southeast1:cashflow-mysql"
DB_NAME="cashflow_prod"
DB_USER="root"
DB_PUBLIC_IP="34.87.113.215"
PUBSUB_TOPIC="cashflow-events"
WORKER_SUBSCRIPTION="cashflow-events-worker"

RUNTIME_SA_NAME="cashflow-runtime"
RUNTIME_SA_EMAIL="${RUNTIME_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
DB_URL_SECRET="cashflow-db-url"

# ---- Require password without echoing ----
if [[ -z "${DB_PASS:-}" ]]; then
  read -s -p "Cloud SQL password for ${DB_USER}: " DB_PASS
  echo
fi

# ---- gcloud project ----
gcloud config set project "$PROJECT_ID" 1>/dev/null

# ---- Build images ----
echo "Building images with Cloud Build..."
# Note: config is in ./deploy/, but build needs root context, so we pass current directory '.' as source
# but point to the config file in deploy/ folder.
# Actually, gcloud builds submit takes source as arg (default .).
# We must ensure we run this script from project root or adjust paths.

# Assuming user runs ./deploy/deploy_gcp.sh from root, or we cd to root.
# Let's find root based on script location.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

echo "Deploying from root: $ROOT_DIR"
cd "$ROOT_DIR"

gcloud builds submit --config deploy/cloudbuild.api.yaml .
# Frontend is a separate Cloud Run service. Build it too so UI updates are deployed.
gcloud builds submit --config deploy/cloudbuild.frontend.yaml .
#gcloud builds submit --config deploy/cloudbuild.worker.yaml .
gcloud builds submit --config deploy/cloudbuild.publisher.yaml .
# NOTE: uncomment the line above if you want to rebuild worker every run.

# ---- Apply migrations to Cloud SQL via Proxy ----
echo "Setting up Cloud SQL Proxy..."

if command -v cloud-sql-proxy >/dev/null; then
  PROXY_CMD="cloud-sql-proxy"
elif [ -f "./cloud-sql-proxy" ]; then
  PROXY_CMD="./cloud-sql-proxy"
else
  echo "Downloading cloud-sql-proxy..."
  if [[ "$OSTYPE" == "darwin"* ]]; then
    curl -o cloud-sql-proxy https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2/latest/cloud-sql-proxy.darwin.amd64
  else
    curl -o cloud-sql-proxy https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2/latest/cloud-sql-proxy.linux.amd64
  fi
  chmod +x cloud-sql-proxy
  PROXY_CMD="./cloud-sql-proxy"
fi

echo "Starting proxy on port 3307..."
$PROXY_CMD --address 0.0.0.0 --port 3307 "$INSTANCE_CONN" > /dev/null 2>&1 &
PROXY_PID=$!

# Ensure proxy is killed on script exit
trap "kill $PROXY_PID 2>/dev/null" EXIT

echo "Waiting for proxy..."
sleep 5

echo "Applying Prisma migrations to Cloud SQL..."
export DATABASE_URL="mysql://${DB_USER}:${DB_PASS}@localhost:3307/${DB_NAME}"
./node_modules/.bin/prisma migrate deploy --schema prisma/schema.prisma

# ---- Create runtime service account (if missing) ----
if ! gcloud iam service-accounts describe "$RUNTIME_SA_EMAIL" >/dev/null 2>&1; then
  echo "Creating service account ${RUNTIME_SA_EMAIL}..."
  gcloud iam service-accounts create "$RUNTIME_SA_NAME" --display-name="Cashflow Cloud Run runtime"
fi

# ---- IAM bindings ----
echo "Ensuring IAM roles (Cloud SQL + Pub/Sub + Secret Manager)..."

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${RUNTIME_SA_EMAIL}" \
  --role="roles/cloudsql.client" >/dev/null

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${RUNTIME_SA_EMAIL}" \
  --role="roles/pubsub.publisher" >/dev/null

# ---- Secret Manager: store Cloud Run DATABASE_URL using unix socket ----
SOCKET_DB_URL="mysql://${DB_USER}:${DB_PASS}@localhost:3306/${DB_NAME}?socket=/cloudsql/${INSTANCE_CONN}"

if ! gcloud secrets describe "$DB_URL_SECRET" >/dev/null 2>&1; then
  echo "Creating secret ${DB_URL_SECRET}..."
  printf '%s' "$SOCKET_DB_URL" | gcloud secrets create "$DB_URL_SECRET" --data-file=- >/dev/null
else
  echo "Updating secret ${DB_URL_SECRET} (new version)..."
  printf '%s' "$SOCKET_DB_URL" | gcloud secrets versions add "$DB_URL_SECRET" --data-file=- >/dev/null
fi

gcloud secrets add-iam-policy-binding "$DB_URL_SECRET" \
  --member="serviceAccount:${RUNTIME_SA_EMAIL}" \
  --role="roles/secretmanager.secretAccessor" >/dev/null

# ---- Deploy services ----
# NOTE: These deploys do not print DB passwords because DATABASE_URL is sourced from Secret Manager.

echo "Deploying cashflow-api..."
# Clear literal DATABASE_URL first if it exists, to allow switching to secret
gcloud run services update cashflow-api \
  --region "$REGION" \
  --remove-env-vars DATABASE_URL 2>/dev/null || true

gcloud run deploy cashflow-api \
  --image "gcr.io/${PROJECT_ID}/cashflow-api" \
  --region "$REGION" \
  --add-cloudsql-instances "$INSTANCE_CONN" \
  --set-env-vars "PUBSUB_TOPIC=${PUBSUB_TOPIC}" \
  --set-secrets "DATABASE_URL=${DB_URL_SECRET}:latest" \
  --service-account "$RUNTIME_SA_EMAIL"

echo "Deploying cashflow-worker..."
# Clear literal DATABASE_URL first if it exists
gcloud run services update cashflow-worker \
  --region "$REGION" \
  --remove-env-vars DATABASE_URL 2>/dev/null || true

gcloud run deploy cashflow-worker \
  --image "gcr.io/${PROJECT_ID}/cashflow-worker" \
  --region "$REGION" \
  --add-cloudsql-instances "$INSTANCE_CONN" \
  --set-env-vars "ENFORCE_PUBSUB_OIDC_AUTH=true,PUBSUB_PUSH_SA_EMAIL=${RUNTIME_SA_EMAIL}" \
  --set-secrets "DATABASE_URL=${DB_URL_SECRET}:latest" \
  --service-account "$RUNTIME_SA_EMAIL" \
  --no-allow-unauthenticated

echo "Deploying cashflow-publisher..."
gcloud run deploy cashflow-publisher \
  --image "gcr.io/${PROJECT_ID}/cashflow-publisher" \
  --region "$REGION" \
  --add-cloudsql-instances "$INSTANCE_CONN" \
  --set-env-vars "PUBSUB_TOPIC=${PUBSUB_TOPIC},PUBLISH_INTERVAL_MS=1000,PUBLISH_BATCH_SIZE=50,LOCK_TIMEOUT_MS=60000" \
  --set-secrets "DATABASE_URL=${DB_URL_SECRET}:latest" \
  --service-account "$RUNTIME_SA_EMAIL" \
  --no-allow-unauthenticated

echo "Deploying cashflow-frontend..."
# NOTE: Frontend bakes NEXT_PUBLIC_API_URL at build-time (see frontend/Dockerfile).
# That value is configured in deploy/cloudbuild.frontend.yaml substitutions.
gcloud run deploy cashflow-frontend \
  --image "gcr.io/${PROJECT_ID}/cashflow-frontend" \
  --region "$REGION" \
  --allow-unauthenticated

# ---- Pub/Sub ordering (Recreate to enable) ----
echo "Configuring Pub/Sub subscription ${WORKER_SUBSCRIPTION}..."

# 1. Get Worker URL
WORKER_URL=$(gcloud run services describe cashflow-worker --region "$REGION" --format='value(status.url)')
echo "Worker URL: ${WORKER_URL}"

# 2. Recreate subscription with ordering (Ordering cannot be enabled on existing subs)
echo "Recreating subscription to ensure message ordering is enabled..."
gcloud pubsub subscriptions delete "$WORKER_SUBSCRIPTION" --quiet 2>/dev/null || true

gcloud pubsub subscriptions create "$WORKER_SUBSCRIPTION" \
  --topic "$PUBSUB_TOPIC" \
  --push-endpoint "${WORKER_URL}/pubsub/push" \
  --push-auth-service-account "$RUNTIME_SA_EMAIL" \
  --push-auth-token-audience "${WORKER_URL}/pubsub/push" \
  --enable-message-ordering \
  --ack-deadline=60 \
  --quiet

# Update worker audience to match subscription push auth audience (OIDC)
echo "Setting worker PUBSUB_PUSH_AUDIENCE to ${WORKER_URL}/pubsub/push ..."
gcloud run services update cashflow-worker \
  --region "$REGION" \
  --update-env-vars "PUBSUB_PUSH_AUDIENCE=${WORKER_URL}/pubsub/push" >/dev/null

echo "Done. Environment is fully deployed with Step 1 (Envelope) + Step 2 (Outbox) + Ordering."
