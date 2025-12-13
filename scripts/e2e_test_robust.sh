#!/bin/bash
# End-to-End Idempotency Test (Robust Version)

API_URL="https://cashflow-api-291129507535.asia-southeast1.run.app"
WORKER_URL="https://cashflow-worker-291129507535.asia-southeast1.run.app"
COMPANY_ID=1

get_json_value() {
  echo "$1" | grep -o "\"$2\":[^,}]*" | cut -d: -f2 | tr -d '"' | tr -d ' '
}

echo "Checking baseline PnL..."
DATE_START=$(date +%Y-%m-01)
DATE_END=$(date +%Y-%m-%d)
BASELINE=$(curl -k -s "$API_URL/reports/pnl?companyId=$COMPANY_ID&from=$DATE_START&to=$DATE_END")
BASELINE_INCOME=$(get_json_value "$BASELINE" "totalIncome")

echo "Baseline Income: $BASELINE_INCOME"

# Account IDs (Hardcoded from previous success to save time/calls)
INCOME_ID=5
CASH_ID=1

echo "Creating Journal Entry..."
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# Use Python to generate safe JSON
PAYLOAD=$(python3 -c "import json; print(json.dumps({'companyId': $COMPANY_ID, 'date': '$NOW', 'description': 'Robust Test', 'lines': [{'accountId': $INCOME_ID, 'debit': 0, 'credit': 100}, {'accountId': $CASH_ID, 'debit': 100, 'credit': 0}]}))")

ENTRY_RESP=$(curl -k -s -X POST "$API_URL/journal-entries" -H "Content-Type: application/json" -d "$PAYLOAD")
ENTRY_ID=$(get_json_value "$ENTRY_RESP" "id")
echo "Created Entry ID: $ENTRY_ID"

echo "Waiting 10s for worker..."
sleep 10

UPDATED=$(curl -k -s "$API_URL/reports/pnl?companyId=$COMPANY_ID&from=$DATE_START&to=$DATE_END")
UPDATED_INCOME=$(get_json_value "$UPDATED" "totalIncome")
echo "Updated Income: $UPDATED_INCOME (Expected +100)"

# Simulate Duplicate
TEST_EVENT_ID="test-dedup-robust-$(date +%s)"
echo "Generating Duplicate Payload..."

# Python script to generate the exact Pub/Sub push body with base64 encoded envelope
PUSH_PAYLOAD=$(python3 -c "
import json, base64
envelope = {
    'eventId': '$TEST_EVENT_ID',
    'eventType': 'journal.entry.created',
    'schemaVersion': 'v1',
    'occurredAt': '$NOW',
    'companyId': $COMPANY_ID,
    'source': 'robust-test',
    'payload': {
        'journalEntryId': $ENTRY_ID,
        'companyId': $COMPANY_ID,
        'totalDebit': 100,
        'totalCredit': 100
    }
}
envelope_json = json.dumps(envelope)
data_b64 = base64.b64encode(envelope_json.encode('utf-8')).decode('utf-8')
print(json.dumps({'message': {'data': data_b64}}))
")

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

