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
gcloud builds submit --config cloudbuild.api.yaml
#gcloud builds submit --config cloudbuild.worker.yaml
gcloud builds submit --config cloudbuild.publisher.yaml
# NOTE: uncomment the line above if you want to rebuild worker every run.

# ---- Apply migrations to Cloud SQL via public IP ----
# (Using public IP because your machine is already authorized. For production hardening,
# prefer running migrations from a private build/job inside GCP.)
echo "Applying Prisma migrations to Cloud SQL (${DB_PUBLIC_IP})..."
export DATABASE_URL="mysql://${DB_USER}:${DB_PASS}@${DB_PUBLIC_IP}:3306/${DB_NAME}"
npx prisma migrate deploy

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
  --set-secrets "DATABASE_URL=${DB_URL_SECRET}:latest" \
  --service-account "$RUNTIME_SA_EMAIL"

echo "Deploying cashflow-publisher..."
gcloud run deploy cashflow-publisher \
  --image "gcr.io/${PROJECT_ID}/cashflow-publisher" \
  --region "$REGION" \
  --add-cloudsql-instances "$INSTANCE_CONN" \
  --set-env-vars "PUBSUB_TOPIC=${PUBSUB_TOPIC},PUBLISH_INTERVAL_MS=1000,PUBLISH_BATCH_SIZE=50,LOCK_TIMEOUT_MS=60000" \
  --set-secrets "DATABASE_URL=${DB_URL_SECRET}:latest" \
  --service-account "$RUNTIME_SA_EMAIL" \
  --no-allow-unauthenticated

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
  --enable-message-ordering \
  --ack-deadline=60 \
  --quiet

echo "Done. Environment is fully deployed with Step 1 (Envelope) + Step 2 (Outbox) + Ordering."
