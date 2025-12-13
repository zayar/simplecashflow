#!/bin/bash

# Quick Idempotency Test Script
# This script helps you quickly test idempotency

set -e

API_URL="https://cashflow-api-291129507535.asia-southeast1.run.app"
WORKER_URL="https://cashflow-worker-291129507535.asia-southeast1.run.app"
DB_HOST="34.87.113.215"
DB_USER="root"
DB_PASS="P@ssw0rd"
DB_NAME="cashflow_prod"

if [ -z "$1" ]; then
  echo "Usage: ./quick_test.sh <companyId>"
  echo ""
  echo "Example: ./quick_test.sh 1"
  exit 1
fi

COMPANY_ID=$1

echo "=========================================="
echo "Quick Idempotency Test"
echo "Company ID: $COMPANY_ID"
echo "=========================================="
echo ""

# Step 1: Get account IDs
echo "Step 1: Fetching account IDs..."
INCOME_ACCOUNT_ID=$(mysql -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -se \
  "SELECT id FROM Account WHERE companyId=$COMPANY_ID AND code='4000' LIMIT 1" 2>/dev/null || echo "")

CASH_ACCOUNT_ID=$(mysql -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -se \
  "SELECT id FROM Account WHERE companyId=$COMPANY_ID AND code='1000' LIMIT 1" 2>/dev/null || echo "")

if [ -z "$INCOME_ACCOUNT_ID" ] || [ -z "$CASH_ACCOUNT_ID" ]; then
  echo "❌ Could not find required accounts (code 4000 and 1000)"
  echo "Please check your database or create accounts first."
  exit 1
fi

echo "✅ Found accounts:"
echo "   Income (4000): ID $INCOME_ACCOUNT_ID"
echo "   Cash (1000): ID $CASH_ACCOUNT_ID"
echo ""

# Step 2: Create journal entry
echo "Step 2: Creating journal entry..."
ENTRY_RESPONSE=$(curl -s -X POST "$API_URL/journal-entries" \
  -H "Content-Type: application/json" \
  -d "{
    \"companyId\": $COMPANY_ID,
    \"date\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
    \"description\": \"Idempotency test entry\",
    \"lines\": [
      {
        \"accountId\": $INCOME_ACCOUNT_ID,
        \"debit\": 0,
        \"credit\": 1000
      },
      {
        \"accountId\": $CASH_ACCOUNT_ID,
        \"debit\": 1000,
        \"credit\": 0
      }
    ]
  }")

ENTRY_ID=$(echo "$ENTRY_RESPONSE" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)

if [ -z "$ENTRY_ID" ]; then
  echo "❌ Failed to create journal entry"
  echo "Response: $ENTRY_RESPONSE"
  exit 1
fi

echo "✅ Journal Entry Created: ID $ENTRY_ID"
echo ""

# Step 3: Wait and get event details
echo "Step 3: Waiting 5 seconds for event processing..."
sleep 5

echo "Fetching event details..."
EVENT_ID=$(mysql -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -se \
  "SELECT eventId FROM Event WHERE companyId=$COMPANY_ID ORDER BY createdAt DESC LIMIT 1" 2>/dev/null || echo "")

if [ -z "$EVENT_ID" ]; then
  echo "⚠️  Could not find event. Please check manually:"
  echo "   SELECT eventId, payload FROM Event WHERE companyId=$COMPANY_ID ORDER BY createdAt DESC LIMIT 1;"
  exit 1
fi

echo "✅ Found eventId: $EVENT_ID"
echo ""

# Step 4: Check initial DailySummary
echo "Step 4: Checking initial DailySummary..."
INITIAL_INCOME=$(mysql -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -se \
  "SELECT totalIncome FROM DailySummary WHERE companyId=$COMPANY_ID ORDER BY date DESC LIMIT 1" 2>/dev/null || echo "0")
INITIAL_EXPENSE=$(mysql -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -se \
  "SELECT totalExpense FROM DailySummary WHERE companyId=$COMPANY_ID ORDER BY date DESC LIMIT 1" 2>/dev/null || echo "0")

echo "Initial values:"
echo "   totalIncome: $INITIAL_INCOME"
echo "   totalExpense: $INITIAL_EXPENSE"
echo ""

# Step 5: Simulate duplicate
echo "Step 5: Simulating duplicate event delivery..."
echo "Creating event envelope..."

# Create envelope JSON
ENVELOPE_JSON=$(cat <<EOF
{
  "eventId": "$EVENT_ID",
  "eventType": "journal.entry.created",
  "schemaVersion": "v1",
  "occurredAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "companyId": $COMPANY_ID,
  "source": "cashflow-api",
  "payload": {
    "journalEntryId": $ENTRY_ID,
    "companyId": $COMPANY_ID,
    "totalDebit": 1000,
    "totalCredit": 1000
  }
}
EOF
)

# Base64 encode
ENVELOPE_B64=$(echo -n "$ENVELOPE_JSON" | base64)

# Create push payload
PUSH_PAYLOAD=$(cat <<EOF
{
  "message": {
    "data": "$ENVELOPE_B64"
  }
}
EOF
)

# POST to worker
WORKER_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$WORKER_URL/pubsub/push" \
  -H "Content-Type: application/json" \
  -d "$PUSH_PAYLOAD")

HTTP_CODE=$(echo "$WORKER_RESPONSE" | tail -1)
if [ "$HTTP_CODE" = "204" ]; then
  echo "✅ Worker responded (204 No Content)"
else
  echo "⚠️  Worker responded with code: $HTTP_CODE"
  echo "Response: $WORKER_RESPONSE"
fi
echo ""

# Step 6: Wait and check final DailySummary
echo "Step 6: Waiting 3 seconds, then checking final DailySummary..."
sleep 3

FINAL_INCOME=$(mysql -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -se \
  "SELECT totalIncome FROM DailySummary WHERE companyId=$COMPANY_ID ORDER BY date DESC LIMIT 1" 2>/dev/null || echo "0")
FINAL_EXPENSE=$(mysql -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -se \
  "SELECT totalExpense FROM DailySummary WHERE companyId=$COMPANY_ID ORDER BY date DESC LIMIT 1" 2>/dev/null || echo "0")

echo "Final values:"
echo "   totalIncome: $FINAL_INCOME"
echo "   totalExpense: $FINAL_EXPENSE"
echo ""

# Step 7: Verify
echo "=========================================="
echo "Verification"
echo "=========================================="

if [ "$INITIAL_INCOME" = "$FINAL_INCOME" ] && [ "$INITIAL_EXPENSE" = "$FINAL_EXPENSE" ]; then
  echo "✅ SUCCESS! Idempotency is working correctly."
  echo "   Values did NOT double after duplicate delivery."
else
  echo "❌ FAILED! Values changed after duplicate delivery."
  echo "   This indicates idempotency is NOT working."
fi
echo ""

echo "Step 7: Check worker logs:"
echo "gcloud logs read \\"
echo "  \"resource.type=cloud_run_revision AND resource.labels.service_name=cashflow-worker\" \\"
echo "  --limit=20 --format=\"value(textPayload)\" --project=aiaccount-1c845"
echo ""
echo "Look for: 'Duplicate event detected, skipping (idempotent)'"

