#!/usr/bin/env bash
set -euo pipefail

# Run Prisma migrations against Cloud SQL using Cloud SQL Proxy (v2).
#
# This script ONLY runs migrations (no build/deploy).
#
# Usage:
#   export DB_PASS='your_cloud_sql_password'
#   ./scripts/migrate_cloudsql.sh
#
# Optional overrides:
#   PROJECT_ID, REGION, INSTANCE_CONN, DB_NAME, DB_USER, PROXY_PORT

PROJECT_ID="${PROJECT_ID:-aiaccount-1c845}"
REGION="${REGION:-asia-southeast1}"
INSTANCE_CONN="${INSTANCE_CONN:-aiaccount-1c845:asia-southeast1:cashflow-mysql}"
DB_NAME="${DB_NAME:-cashflow_prod}"
DB_USER="${DB_USER:-root}"
PROXY_PORT="${PROXY_PORT:-3307}"

if [[ -z "${DB_PASS:-}" ]]; then
  echo "Please set DB_PASS environment variable"
  echo "export DB_PASS='your_password_here'"
  exit 1
fi

cd "$(dirname "$0")/.."

echo "Using Cloud SQL instance: ${INSTANCE_CONN}"
echo "DB: ${DB_NAME} user: ${DB_USER} proxy port: ${PROXY_PORT}"

# Find proxy binary
if command -v cloud-sql-proxy >/dev/null 2>&1; then
  PROXY_CMD="cloud-sql-proxy"
elif [ -f "./cloud-sql-proxy" ]; then
  PROXY_CMD="./cloud-sql-proxy"
else
  echo "cloud-sql-proxy not found."
  echo "Install it (recommended) or run ./deploy/deploy_gcp.sh which downloads it automatically."
  echo "Docs: https://cloud.google.com/sql/docs/mysql/sql-proxy"
  exit 1
fi

echo "Starting Cloud SQL Proxy on 127.0.0.1:${PROXY_PORT}..."
$PROXY_CMD --address 127.0.0.1 --port "${PROXY_PORT}" "${INSTANCE_CONN}" >/dev/null 2>&1 &
PROXY_PID=$!
trap "kill ${PROXY_PID} 2>/dev/null || true" EXIT

sleep 3

export DATABASE_URL="mysql://${DB_USER}:${DB_PASS}@127.0.0.1:${PROXY_PORT}/${DB_NAME}"

echo "Checking migration status..."
# `migrate status` returns non-zero when there are pending migrations.
# We want to show status but still continue to deploy.
./node_modules/.bin/prisma migrate status --schema prisma/schema.prisma || true

echo "Applying migrations (deploy)..."
./node_modules/.bin/prisma migrate deploy --schema prisma/schema.prisma

echo "Regenerating Prisma client..."
./node_modules/.bin/prisma generate --schema prisma/schema.prisma

echo "✅ Done."

echo ""
echo "Optional backfill (recommended after enabling amountPaid guardrails):"
echo "  npx tsx scripts/backfill_invoice_amount_paid.ts --companyId=<YOUR_COMPANY_ID>"
echo ""


