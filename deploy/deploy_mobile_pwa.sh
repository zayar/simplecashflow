#!/usr/bin/env bash
set -euo pipefail

# Deploy the Vite-based mobile PWA to Cloud Run.
#
# Usage:
#   ./deploy/deploy_mobile_pwa.sh
#
# Optional env:
#   export PROJECT_ID="aiaccount-1c845"
#   export REGION="asia-southeast1"
#   export VITE_API_URL="https://cashflow-api-....run.app"

PROJECT_ID="${PROJECT_ID:-aiaccount-1c845}"
REGION="${REGION:-asia-southeast1}"
VITE_API_URL="${VITE_API_URL:-https://cashflow-api-291129507535.asia-southeast1.run.app}"

gcloud config set project "$PROJECT_ID" 1>/dev/null

echo "Building mobile PWA image with Cloud Build..."
gcloud builds submit \
  --config deploy/cloudbuild.mobile_pwa.yaml \
  --substitutions "_VITE_API_URL=${VITE_API_URL}" \
  .

echo "Deploying cashflow-mobile-pwa to Cloud Run..."
gcloud run deploy cashflow-mobile-pwa \
  --image "gcr.io/${PROJECT_ID}/cashflow-mobile-pwa" \
  --region "${REGION}" \
  --port 8080 \
  --allow-unauthenticated

echo "✅ Mobile PWA deployed."


