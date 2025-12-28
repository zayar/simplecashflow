#!/usr/bin/env bash
set -euo pipefail

# Deploy ONLY the Next.js frontend to Cloud Run.
# Use this when you changed UI only (files under ./frontend) and did NOT change:
# - ./src (API/backend)
# - ./prisma (schema/migrations)
#
# Usage:
#   ./deploy/deploy_frontend_only.sh
#
# Optional:
#   export PROJECT_ID="aiaccount-1c845"
#   export REGION="asia-southeast1"
#   export NEXT_PUBLIC_API_URL="https://cashflow-api-....run.app"

PROJECT_ID="${PROJECT_ID:-aiaccount-1c845}"
REGION="${REGION:-asia-southeast1}"
NEXT_PUBLIC_API_URL="${NEXT_PUBLIC_API_URL:-https://cashflow-api-291129507535.asia-southeast1.run.app}"
NEXT_PUBLIC_APP_LOGIN_URL="${NEXT_PUBLIC_APP_LOGIN_URL:-}"

gcloud --quiet config set project "$PROJECT_ID" 1>/dev/null

echo "Building frontend image with Cloud Build..."
gcloud builds submit \
  --quiet \
  --config deploy/cloudbuild.frontend.yaml \
  --substitutions "_NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}" \
  .

echo "Deploying cashflow-frontend to Cloud Run..."
if [[ -n "${NEXT_PUBLIC_APP_LOGIN_URL}" ]]; then
  gcloud run deploy cashflow-frontend \
    --quiet \
    --image "gcr.io/${PROJECT_ID}/cashflow-frontend" \
    --region "${REGION}" \
    --set-env-vars "NEXT_PUBLIC_APP_LOGIN_URL=${NEXT_PUBLIC_APP_LOGIN_URL}" \
    --allow-unauthenticated
else
  gcloud run deploy cashflow-frontend \
    --quiet \
    --image "gcr.io/${PROJECT_ID}/cashflow-frontend" \
    --region "${REGION}" \
    --allow-unauthenticated
fi

echo "✅ Frontend deployed."


