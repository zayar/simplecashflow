#!/usr/bin/env bash
set -euo pipefail

# Backup restore verification (Cloud SQL)
#
# Goal: prove we can restore a recent backup into a staging clone and run a minimal smoke check.
#
# Required env vars:
#   GCP_PROJECT                (e.g. my-prod-project)
#   SOURCE_INSTANCE            (e.g. cashflow-prod)
#   RESTORE_INSTANCE           (e.g. cashflow-restore-verify-$(date +%Y%m%d))
#   REGION                     (e.g. asia-southeast1)
#
# Optional env vars:
#   BACKUP_ID                  (if omitted, the script uses the latest successful backup)
#   DRY_RUN=true               (print commands only)
#
# Notes:
# - This script is intentionally conservative and DOES NOT delete instances automatically.
# - Run this against a non-production project unless you have an approved drill window.

DRY_RUN="${DRY_RUN:-false}"
GCP_PROJECT="${GCP_PROJECT:-}"
SOURCE_INSTANCE="${SOURCE_INSTANCE:-}"
RESTORE_INSTANCE="${RESTORE_INSTANCE:-}"
REGION="${REGION:-}"
BACKUP_ID="${BACKUP_ID:-}"

if [[ -z "${GCP_PROJECT}" || -z "${SOURCE_INSTANCE}" || -z "${RESTORE_INSTANCE}" || -z "${REGION}" ]]; then
  echo "Missing required env vars. See script header." >&2
  exit 2
fi

run() {
  if [[ "${DRY_RUN}" == "true" ]]; then
    echo "[dry-run] $*"
    return 0
  fi
  eval "$@"
}

echo "Project: ${GCP_PROJECT}"
echo "Source instance: ${SOURCE_INSTANCE}"
echo "Restore instance: ${RESTORE_INSTANCE}"
echo "Region: ${REGION}"

if [[ -z "${BACKUP_ID}" ]]; then
  echo "Finding latest successful backup id..."
  BACKUP_ID="$(gcloud sql backups list \
    --project "${GCP_PROJECT}" \
    --instance "${SOURCE_INSTANCE}" \
    --filter="status:SUCCESSFUL" \
    --sort-by="~endTime" \
    --limit=1 \
    --format="value(id)")"
fi

if [[ -z "${BACKUP_ID}" ]]; then
  echo "Could not determine BACKUP_ID (no successful backups found?)" >&2
  exit 3
fi

echo "Using BACKUP_ID=${BACKUP_ID}"

echo "Creating restore clone instance..."
run "gcloud sql instances clone \"${SOURCE_INSTANCE}\" \"${RESTORE_INSTANCE}\" --project \"${GCP_PROJECT}\" --quiet"

echo "Restoring backup into clone..."
run "gcloud sql backups restore \"${BACKUP_ID}\" --restore-instance \"${RESTORE_INSTANCE}\" --backup-instance \"${SOURCE_INSTANCE}\" --project \"${GCP_PROJECT}\" --quiet"

echo ""
echo "Next steps (manual / environment-specific):"
echo "1) Connect to the restored DB (Cloud SQL Proxy / private IP)."
echo "2) Run basic SQL checks:"
cat <<'SQL'
-- Example checks (adjust database name/schema as needed)
SELECT COUNT(*) AS companies FROM Company;
SELECT COUNT(*) AS invoices FROM Invoice;
SELECT COUNT(*) AS payments FROM Payment;
SELECT COUNT(*) AS stockBalances FROM StockBalance;
SELECT COUNT(*) AS stockMoves FROM StockMove;
SELECT COUNT(*) AS purchaseBills FROM PurchaseBill;
SELECT COUNT(*) AS purchaseBillPayments FROM PurchaseBillPayment;
SELECT COUNT(*) AS auditLogs FROM AuditLog;
SQL
echo ""
echo "3) Optional: deploy a staging API pointing at the restored DB and run smoke calls:"
echo "   - GET /health"
echo "   - List invoices/purchase bills"
echo "   - Generate a report (trial balance / inventory summary)"
echo ""
echo "IMPORTANT: This script does NOT delete ${RESTORE_INSTANCE}. Delete it when the drill is complete."


