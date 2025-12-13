#!/bin/bash

# Test Idempotency Script
# This script helps you test that duplicate events don't cause double-counting

set -e

API_URL="https://cashflow-api-291129507535.asia-southeast1.run.app"
WORKER_URL="https://cashflow-worker-291129507535.asia-southeast1.run.app"

echo "=========================================="
echo "STEP 1: Create a Journal Entry via API"
echo "=========================================="

# First, let's get or create a company (you may need to adjust companyId)
COMPANY_ID=${1:-1}  # Use first argument or default to 1

echo "Using companyId: $COMPANY_ID"
echo ""

# Create a journal entry with income/expense impact
echo "Creating journal entry..."
RESPONSE=$(curl -s -X POST "$API_URL/journal-entries" \
  -H "Content-Type: application/json" \
  -d "{
    \"companyId\": $COMPANY_ID,
    \"date\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
    \"description\": \"Test entry for idempotency\",
    \"lines\": [
      {
        \"accountId\": $(mysql -h 34.87.113.215 -u root -p'P@ssw0rd' cashflow_prod -se "SELECT id FROM Account WHERE companyId=$COMPANY_ID AND code='4000' LIMIT 1" 2>/dev/null || echo "null"),
        \"debit\": 0,
        \"credit\": 1000
      },
      {
        \"accountId\": $(mysql -h 34.87.113.215 -u root -p'P@ssw0rd' cashflow_prod -se "SELECT id FROM Account WHERE companyId=$COMPANY_ID AND code='1000' LIMIT 1" 2>/dev/null || echo "null"),
        \"debit\": 1000,
        \"credit\": 0
      }
    ]
  }")

echo "Response: $RESPONSE"
echo ""

# Extract eventId from the response (you'll need to check the Event table)
echo "Waiting 5 seconds for event processing..."
sleep 5

echo ""
echo "=========================================="
echo "STEP 2: Check Initial DailySummary"
echo "=========================================="
echo "Check your database:"
echo "  SELECT * FROM DailySummary WHERE companyId=$COMPANY_ID ORDER BY date DESC LIMIT 1;"
echo ""

echo "=========================================="
echo "STEP 3: Simulate Duplicate Delivery"
echo "=========================================="
echo "Option A: Use Pub/Sub Console to redeliver a message"
echo "Option B: Manually POST the same envelope (see below)"
echo ""

echo "To manually test, you'll need to:"
echo "1. Get the eventId from the Event table:"
echo "   SELECT eventId, eventType, payload FROM Event WHERE companyId=$COMPANY_ID ORDER BY createdAt DESC LIMIT 1;"
echo ""
echo "2. Then POST to worker (see test_duplicate.sh script)"
echo ""

echo "=========================================="
echo "STEP 4: Check Logs"
echo "=========================================="
echo "Run this command to see worker logs:"
echo ""
echo "gcloud logs read \\"
echo "  \"resource.type=cloud_run_revision AND resource.labels.service_name=cashflow-worker\" \\"
echo "  --limit=20 --format=\"value(textPayload)\""
echo ""

echo "You should see:"
echo "  - First time: 'Updating DailySummary'"
echo "  - Second time: 'Duplicate event detected, skipping (idempotent)'"
echo ""

echo "=========================================="
echo "STEP 5: Verify DailySummary Didn't Double"
echo "=========================================="
echo "Check your database again:"
echo "  SELECT * FROM DailySummary WHERE companyId=$COMPANY_ID ORDER BY date DESC LIMIT 1;"
echo ""
echo "totalIncome and totalExpense should be the SAME as Step 2 (not doubled)"
echo ""

