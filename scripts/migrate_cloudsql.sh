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

# URL-encode DB password for DATABASE_URL (needed if it contains @, :, /, #, etc.)
DB_PASS_ENC="$(node -e "process.stdout.write(encodeURIComponent(process.env.DB_PASS || ''))")"

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
PROXY_LOG="$(pwd)/.cloudsql-proxy.log"
rm -f "$PROXY_LOG" || true
echo "Proxy logs: ${PROXY_LOG}"
$PROXY_CMD --address 127.0.0.1 --port "${PROXY_PORT}" "${INSTANCE_CONN}" >"$PROXY_LOG" 2>&1 &
PROXY_PID=$!
trap "kill ${PROXY_PID} 2>/dev/null || true" EXIT

# Wait until proxy is actually listening.
for i in {1..30}; do
  if ! kill -0 "$PROXY_PID" 2>/dev/null; then
    echo "Cloud SQL Proxy exited unexpectedly. Last 50 log lines:"
    tail -n 50 "$PROXY_LOG" || true
    exit 1
  fi
  if command -v nc >/dev/null 2>&1; then
    if nc -z 127.0.0.1 "${PROXY_PORT}" >/dev/null 2>&1; then
      break
    fi
  fi
  sleep 1
done

export DATABASE_URL="mysql://${DB_USER}:${DB_PASS_ENC}@127.0.0.1:${PROXY_PORT}/${DB_NAME}"

echo "Checking DB connectivity..."
./node_modules/.bin/prisma db execute --schema prisma/schema.prisma --stdin <<'SQL'
SELECT 1;
SQL

echo "Checking migration status..."
# `migrate status` returns non-zero when there are pending migrations.
# We want to show status but still continue to deploy.
./node_modules/.bin/prisma migrate status --schema prisma/schema.prisma || true

echo "Applying migrations (deploy)..."
for attempt in 1 2 3; do
  if ./node_modules/.bin/prisma migrate deploy --schema prisma/schema.prisma; then
    break
  fi
  echo "Prisma migrate deploy failed (attempt ${attempt}/3). Retrying in 3s..."
  sleep 3
  if [[ "$attempt" == "3" ]]; then
    echo "Prisma migrate deploy failed after retries. Last 120 proxy log lines:"
    tail -n 120 "$PROXY_LOG" || true
    exit 1
  fi
done

echo "Regenerating Prisma client..."
./node_modules/.bin/prisma generate --schema prisma/schema.prisma

echo "✅ Done."

echo ""
echo "Optional backfill (recommended after enabling amountPaid guardrails):"
echo "  npx tsx scripts/backfill_invoice_amount_paid.ts --companyId=<YOUR_COMPANY_ID>"
echo ""


