#!/bin/bash

# Comprehensive Idempotency Test
# This script tests the full idempotency flow

set -e

API_URL="https://cashflow-api-291129507535.asia-southeast1.run.app"
WORKER_URL="https://cashflow-worker-291129507535.asia-southeast1.run.app"
COMPANY_ID=${1:-1}

echo "=========================================="
echo "Idempotency Test Suite"
echo "Company ID: $COMPANY_ID"
echo "=========================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Step 1: Check API health
echo "Step 1: Checking API health..."
API_HEALTH=$(curl -k -s "$API_URL/health")
if echo "$API_HEALTH" | grep -q "ok"; then
  echo -e "${GREEN}✅ API is healthy${NC}"
else
  echo -e "${RED}❌ API health check failed${NC}"
  echo "Response: $API_HEALTH"
  exit 1
fi
echo ""

# Step 2: Get companies (to verify companyId exists)
echo "Step 2: Fetching companies..."
COMPANIES=$(curl -k -s "$API_URL/companies")
if echo "$COMPANIES" | grep -q "error"; then
  echo -e "${YELLOW}⚠️  Could not fetch companies (database connection issue?)${NC}"
  echo "Response: $COMPANIES"
  echo ""
  echo "Continuing with manual test instructions..."
  echo ""
else
  echo -e "${GREEN}✅ Companies fetched${NC}"
  echo "$COMPANIES" | python3 -m json.tool 2>/dev/null || echo "$COMPANIES"
  echo ""
fi

# Step 3: Get accounts for the company
echo "Step 3: Fetching accounts for company $COMPANY_ID..."
ACCOUNTS=$(curl -k -s "$API_URL/companies/$COMPANY_ID/accounts")
if echo "$ACCOUNTS" | grep -q "error"; then
  echo -e "${YELLOW}⚠️  Could not fetch accounts${NC}"
  echo "Response: $ACCOUNTS"
  echo ""
  echo "You'll need to manually get account IDs from your database:"
  echo "  SELECT id, code, name FROM Account WHERE companyId=$COMPANY_ID AND code IN ('4000', '1000');"
  echo ""
  INCOME_ACCOUNT_ID="<REPLACE_WITH_INCOME_ACCOUNT_ID>"
  CASH_ACCOUNT_ID="<REPLACE_WITH_CASH_ACCOUNT_ID>"
else
  echo -e "${GREEN}✅ Accounts fetched${NC}"
  echo "$ACCOUNTS" | python3 -m json.tool 2>/dev/null || echo "$ACCOUNTS"
  
  # Try to extract account IDs (basic parsing)
  INCOME_ACCOUNT_ID=$(echo "$ACCOUNTS" | grep -o '"id":[0-9]*,"code":"4000"' | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2 || echo "")
  CASH_ACCOUNT_ID=$(echo "$ACCOUNTS" | grep -o '"id":[0-9]*,"code":"1000"' | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2 || echo "")
  
  if [ -z "$INCOME_ACCOUNT_ID" ] || [ -z "$CASH_ACCOUNT_ID" ]; then
    echo -e "${YELLOW}⚠️  Could not auto-extract account IDs${NC}"
    INCOME_ACCOUNT_ID="<REPLACE_WITH_INCOME_ACCOUNT_ID>"
    CASH_ACCOUNT_ID="<REPLACE_WITH_CASH_ACCOUNT_ID>"
  else
    echo "Extracted: Income Account ID=$INCOME_ACCOUNT_ID, Cash Account ID=$CASH_ACCOUNT_ID"
  fi
fi
echo ""

# Step 4: Create journal entry
if [ "$INCOME_ACCOUNT_ID" = "<REPLACE_WITH_INCOME_ACCOUNT_ID>" ] || [ "$CASH_ACCOUNT_ID" = "<REPLACE_WITH_CASH_ACCOUNT_ID>" ]; then
  echo -e "${YELLOW}⚠️  Cannot proceed without account IDs${NC}"
  echo ""
  echo "Please run this command manually:"
  echo ""
  echo "curl -X POST $API_URL/journal-entries \\"
  echo "  -H 'Content-Type: application/json' \\"
  echo "  -d '{"
  echo "    \"companyId\": $COMPANY_ID,"
  echo "    \"date\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
  echo "    \"description\": \"Idempotency test entry\","
  echo "    \"lines\": ["
  echo "      { \"accountId\": <INCOME_ACCOUNT_ID>, \"debit\": 0, \"credit\": 1000 },"
  echo "      { \"accountId\": <CASH_ACCOUNT_ID>, \"debit\": 1000, \"credit\": 0 }"
  echo "    ]"
  echo "  }'"
  echo ""
  exit 0
fi

echo "Step 4: Creating journal entry..."
ENTRY_PAYLOAD=$(cat <<EOF
{
  "companyId": $COMPANY_ID,
  "date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "description": "Idempotency test entry - $(date +%s)",
  "lines": [
    {
      "accountId": $INCOME_ACCOUNT_ID,
      "debit": 0,
      "credit": 1000
    },
    {
      "accountId": $CASH_ACCOUNT_ID,
      "debit": 1000,
      "credit": 0
    }
  ]
}
EOF
)

echo "Payload:"
echo "$ENTRY_PAYLOAD" | python3 -m json.tool 2>/dev/null || echo "$ENTRY_PAYLOAD"
echo ""

ENTRY_RESPONSE=$(curl -k -s -X POST "$API_URL/journal-entries" \
  -H "Content-Type: application/json" \
  -d "$ENTRY_PAYLOAD")

if echo "$ENTRY_RESPONSE" | grep -q "error"; then
  echo -e "${RED}❌ Failed to create journal entry${NC}"
  echo "Response: $ENTRY_RESPONSE"
  exit 1
fi

ENTRY_ID=$(echo "$ENTRY_RESPONSE" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2 || echo "")

if [ -z "$ENTRY_ID" ]; then
  echo -e "${RED}❌ Could not extract entry ID from response${NC}"
  echo "Response: $ENTRY_RESPONSE"
  exit 1
fi

echo -e "${GREEN}✅ Journal Entry Created: ID $ENTRY_ID${NC}"
echo ""

# Step 5: Wait for processing
echo "Step 5: Waiting 10 seconds for event processing..."
for i in {10..1}; do
  echo -ne "\r⏳ Waiting... $i seconds remaining"
  sleep 1
done
echo -e "\r✅ Wait complete                    "
echo ""

# Step 6: Instructions for manual verification
echo "=========================================="
echo "Step 6: Manual Verification Required"
echo "=========================================="
echo ""
echo "Due to database connectivity, please verify manually:"
echo ""
echo "1. Check Event table for the new event:"
echo "   SELECT eventId, eventType, payload FROM Event"
echo "   WHERE companyId=$COMPANY_ID"
echo "   ORDER BY createdAt DESC LIMIT 1;"
echo ""
echo "2. Check initial DailySummary:"
echo "   SELECT * FROM DailySummary"
echo "   WHERE companyId=$COMPANY_ID"
echo "   ORDER BY date DESC LIMIT 1;"
echo ""
echo "   Note the totalIncome and totalExpense values."
echo ""

# Step 7: Simulate duplicate
echo "=========================================="
echo "Step 7: Simulating Duplicate Event"
echo "=========================================="
echo ""
echo "To simulate duplicate delivery, you need:"
echo "  - eventId (from Event table)"
echo "  - journalEntryId (from payload or use: $ENTRY_ID)"
echo ""
echo "Then run this Python script:"
echo "  python3 simulate_duplicate.py <eventId> $COMPANY_ID $ENTRY_ID"
echo ""
echo "Or manually POST to worker (see TESTING_GUIDE.md)"
echo ""

# Step 8: Check logs
echo "=========================================="
echo "Step 8: Check Worker Logs"
echo "=========================================="
echo ""
echo "Run this command to see worker logs:"
echo ""
echo "gcloud logs read \\"
echo "  \"resource.type=cloud_run_revision AND resource.labels.service_name=cashflow-worker\" \\"
echo "  --limit=30 --format=\"value(textPayload)\" --project=aiaccount-1c845"
echo ""
echo "Look for:"
echo "  - 'Updating DailySummary' (first time)"
echo "  - 'Duplicate event detected, skipping (idempotent)' (second time)"
echo ""

echo "=========================================="
echo "Test Setup Complete"
echo "=========================================="
echo ""
echo "Next steps:"
echo "1. Verify the event was created in your database"
echo "2. Note the initial DailySummary values"
echo "3. Simulate duplicate delivery (see Step 7)"
echo "4. Verify DailySummary values didn't change"
echo "5. Check logs to confirm idempotency message"
echo ""

