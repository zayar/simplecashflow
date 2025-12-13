#!/bin/bash

# End-to-End Idempotency Test (Shell Version)

API_URL="https://cashflow-api-291129507535.asia-southeast1.run.app"
WORKER_URL="https://cashflow-worker-291129507535.asia-southeast1.run.app"
COMPANY_ID=1

# Helper to extract JSON value (simple)
get_json_value() {
  echo "$1" | grep -o "\"$2\":[^,}]*" | cut -d: -f2 | tr -d '"' | tr -d ' '
}

echo "Checking baseline PnL..."
DATE_START=$(date +%Y-%m-01)
DATE_END=$(date +%Y-%m-%d)
BASELINE=$(curl -k -s "$API_URL/reports/pnl?companyId=$COMPANY_ID&from=$DATE_START&to=$DATE_END")
BASELINE_INCOME=$(get_json_value "$BASELINE" "totalIncome")

echo "Baseline Income: $BASELINE_INCOME"

# Get Account IDs
ACCOUNTS=$(curl -k -s "$API_URL/companies/$COMPANY_ID/accounts")
# Extract IDs for 4000 and 1000 (Very rough parsing, assuming standard order or simple structure)
# Better to hardcode for this test if parsing fails, but let's try grep magic
INCOME_ID=$(echo "$ACCOUNTS" | grep -o '{"id":[0-9]*,"companyId":1,"code":"4000"' | grep -o '"id":[0-9]*' | cut -d: -f2)
CASH_ID=$(echo "$ACCOUNTS" | grep -o '{"id":[0-9]*,"companyId":1,"code":"1000"' | grep -o '"id":[0-9]*' | cut -d: -f2)

if [ -z "$INCOME_ID" ]; then
    echo "Using fallback IDs (you may need to adjust if this fails)"
    # Fallback to fetching first accounts if grep fails
    INCOME_ID=5 # Guess based on typical seeding
    CASH_ID=1
fi

echo "Using Accounts: Income=$INCOME_ID, Cash=$CASH_ID"

echo "Creating Journal Entry..."
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
PAYLOAD="{\"companyId\":$COMPANY_ID,\"date\":\"$NOW\",\"description\":\"Shell Test\",\"lines\":[{\"accountId\":$INCOME_ID,\"debit\":0,\"credit\":100},{\"accountId\":$CASH_ID,\"debit\":100,\"credit\":0}]}"

ENTRY_RESP=$(curl -k -s -X POST "$API_URL/journal-entries" -H "Content-Type: application/json" -d "$PAYLOAD")
ENTRY_ID=$(get_json_value "$ENTRY_RESP" "id")
echo "Created Entry ID: $ENTRY_ID"

echo "Waiting 10s for worker..."
sleep 10

UPDATED=$(curl -k -s "$API_URL/reports/pnl?companyId=$COMPANY_ID&from=$DATE_START&to=$DATE_END")
UPDATED_INCOME=$(get_json_value "$UPDATED" "totalIncome")
echo "Updated Income: $UPDATED_INCOME (Expected +100 from baseline)"

# Simulate Duplicate
TEST_EVENT_ID="test-dedup-shell-$(date +%s)"
ENVELOPE="{\"eventId\":\"$TEST_EVENT_ID\",\"eventType\":\"journal.entry.created\",\"schemaVersion\":\"v1\",\"occurredAt\":\"$NOW\",\"companyId\":$COMPANY_ID,\"source\":\"shell-test\",\"payload\":{\"journalEntryId\":$ENTRY_ID,\"companyId\":$COMPANY_ID,\"totalDebit\":100,\"totalCredit\":100}}"
ENVELOPE_B64=$(echo -n "$ENVELOPE" | base64)
PUSH_PAYLOAD="{\"message\":{\"data\":\"$ENVELOPE_B64\"}}"

echo "Sending Event $TEST_EVENT_ID (Attempt 1)..."
curl -k -s -X POST "$WORKER_URL/pubsub/push" -H "Content-Type: application/json" -d "$PUSH_PAYLOAD"
sleep 5

MANUAL_1=$(curl -k -s "$API_URL/reports/pnl?companyId=$COMPANY_ID&from=$DATE_START&to=$DATE_END")
MANUAL_1_INCOME=$(get_json_value "$MANUAL_1" "totalIncome")
echo "Income after manual push 1: $MANUAL_1_INCOME"

echo "Sending Event $TEST_EVENT_ID (Attempt 2 - Duplicate)..."
curl -k -s -X POST "$WORKER_URL/pubsub/push" -H "Content-Type: application/json" -d "$PUSH_PAYLOAD"
sleep 5

MANUAL_2=$(curl -k -s "$API_URL/reports/pnl?companyId=$COMPANY_ID&from=$DATE_START&to=$DATE_END")
MANUAL_2_INCOME=$(get_json_value "$MANUAL_2" "totalIncome")
echo "Income after manual push 2: $MANUAL_2_INCOME"

if [ "$MANUAL_1_INCOME" == "$MANUAL_2_INCOME" ]; then
    echo "✅ SUCCESS: Totals matched!"
else
    echo "❌ FAILURE: Totals changed!"
fi

