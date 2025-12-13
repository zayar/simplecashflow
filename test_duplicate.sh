#!/bin/bash

# Script to manually test duplicate event delivery
# Usage: ./test_duplicate.sh <eventId> <companyId>

if [ -z "$1" ] || [ -z "$2" ]; then
  echo "Usage: ./test_duplicate.sh <eventId> <companyId>"
  echo ""
  echo "First, get the eventId from your database:"
  echo "  SELECT eventId, payload FROM Event WHERE companyId=1 ORDER BY createdAt DESC LIMIT 1;"
  exit 1
fi

EVENT_ID=$1
COMPANY_ID=$2
WORKER_URL="https://cashflow-worker-291129507535.asia-southeast1.run.app"

echo "Simulating duplicate delivery for eventId: $EVENT_ID"
echo ""

# You'll need to construct the full envelope from your database
# For now, this is a template - you'll need to fill in the actual values
echo "You need to construct the full envelope. Here's a template:"
echo ""
cat <<EOF
{
  "message": {
    "data": "$(echo -n '{
  "eventId": "'$EVENT_ID'",
  "eventType": "journal.entry.created",
  "schemaVersion": "v1",
  "occurredAt": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'",
  "companyId": $COMPANY_ID,
  "source": "cashflow-api",
  "payload": {
    "journalEntryId": <JOURNAL_ENTRY_ID>,
    "companyId": $COMPANY_ID,
    "totalDebit": 1000,
    "totalCredit": 1000
  }
}' | base64)"
  }
}
EOF

echo ""
echo "To test, POST this to: $WORKER_URL/pubsub/push"
echo ""

