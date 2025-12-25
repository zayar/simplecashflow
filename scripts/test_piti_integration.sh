#!/usr/bin/env bash
set -euo pipefail

# Simple local smoke test for Piti integration endpoint.
#
# Usage:
#   export CASHFLOW_URL='http://localhost:8080'
#   export COMPANY_ID='1'
#   export PITI_KEY='your-dev-key'
#   ./scripts/test_piti_integration.sh

: "${CASHFLOW_URL:=http://localhost:8080}"
: "${COMPANY_ID:=1}"
: "${PITI_KEY:?Missing PITI_KEY env var (must match Cashflow PITI_INTEGRATION_API_KEY)}"

SALE_ID="${SALE_ID:=test-$(date +%s)}"
IDEMPOTENCY_KEY="${IDEMPOTENCY_KEY:=piti:sale:${SALE_ID}:completed}"

echo "POST $CASHFLOW_URL/integrations/piti/companies/$COMPANY_ID/sales"
echo "saleId=$SALE_ID"

curl -sS -X POST "$CASHFLOW_URL/integrations/piti/companies/$COMPANY_ID/sales" \
  -H "Content-Type: application/json" \
  -H "X-Integration-Key: $PITI_KEY" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  -d "{
    \"saleId\": \"${SALE_ID}\",
    \"saleNumber\": \"SO-${SALE_ID}\",
    \"saleDate\": \"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",
    \"currency\": \"MMK\",
    \"customer\": {\"externalCustomerId\": \"cust-${SALE_ID}\", \"name\": \"Walk-in\", \"phone\": \"0990000000\"},
    \"lines\": [
      {\"externalProductId\": \"prod-${SALE_ID}\", \"sku\": \"SKU-${SALE_ID}\", \"name\": \"Test Item\", \"quantity\": 2, \"unitPrice\": 1500, \"discountAmount\": 0, \"taxRate\": 0}
    ],
    \"payments\": [
      {\"cashflowAccountCode\": \"1000\", \"amount\": 3000, \"paidAt\": \"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"}
    ]
  }"

echo ""
echo "Replaying same request (should return same response due to idempotency)"

curl -sS -X POST "$CASHFLOW_URL/integrations/piti/companies/$COMPANY_ID/sales" \
  -H "Content-Type: application/json" \
  -H "X-Integration-Key: $PITI_KEY" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  -d "{
    \"saleId\": \"${SALE_ID}\",
    \"saleNumber\": \"SO-${SALE_ID}\",
    \"saleDate\": \"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",
    \"currency\": \"MMK\",
    \"customer\": {\"externalCustomerId\": \"cust-${SALE_ID}\", \"name\": \"Walk-in\", \"phone\": \"0990000000\"},
    \"lines\": [
      {\"externalProductId\": \"prod-${SALE_ID}\", \"sku\": \"SKU-${SALE_ID}\", \"name\": \"Test Item\", \"quantity\": 2, \"unitPrice\": 1500, \"discountAmount\": 0, \"taxRate\": 0}
    ],
    \"payments\": [
      {\"cashflowAccountCode\": \"1000\", \"amount\": 3000, \"paidAt\": \"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"}
    ]
  }"


