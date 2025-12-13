# Idempotency Testing Guide

This guide walks you through testing that duplicate events don't cause double-counting.

## Prerequisites

- Access to your Cloud SQL database (cashflow_prod)
- `gcloud` CLI installed and authenticated
- `curl` or `python3` installed

## Step 1: Create a Journal Entry

### Option A: Using curl

```bash
curl -X POST https://cashflow-api-291129507535.asia-southeast1.run.app/journal-entries \
  -H "Content-Type: application/json" \
  -d '{
    "companyId": 1,
    "date": "2025-12-12T10:00:00Z",
    "description": "Test entry for idempotency",
    "lines": [
      {
        "accountId": <INCOME_ACCOUNT_ID>,  # Account with code 4000 (Sales Income)
        "debit": 0,
        "credit": 1000
      },
      {
        "accountId": <CASH_ACCOUNT_ID>,    # Account with code 1000 (Cash)
        "debit": 1000,
        "credit": 0
      }
    ]
  }'
```

**First, get your account IDs:**
```sql
SELECT id, code, name FROM Account WHERE companyId=1 AND code IN ('4000', '1000');
```

### Option B: Using Python script

```bash
python3 test_idempotency.py <companyId> <incomeAccountId> <cashAccountId>
```

## Step 2: Check Initial DailySummary

Wait 5-10 seconds for the worker to process the event, then check:

```sql
SELECT * FROM DailySummary 
WHERE companyId=1 
ORDER BY date DESC 
LIMIT 1;
```

**Note the values:**
- `totalIncome` should be 1000 (or previous value + 1000)
- `totalExpense` should be unchanged (or previous value)

Also get the eventId:
```sql
SELECT eventId, eventType, payload 
FROM Event 
WHERE companyId=1 
ORDER BY createdAt DESC 
LIMIT 1;
```

**Save the `eventId` and `journalEntryId` from the payload.**

## Step 3: Simulate Duplicate Delivery

### Option A: Manual POST to Worker

Create a file `duplicate_event.json`:

```json
{
  "message": {
    "data": "<BASE64_ENCODED_ENVELOPE>"
  }
}
```

To generate the base64 envelope, create `envelope.json`:

```json
{
  "eventId": "<EVENT_ID_FROM_STEP_2>",
  "eventType": "journal.entry.created",
  "schemaVersion": "v1",
  "occurredAt": "2025-12-12T10:00:00Z",
  "companyId": 1,
  "source": "cashflow-api",
  "payload": {
    "journalEntryId": <JOURNAL_ENTRY_ID_FROM_STEP_2>,
    "companyId": 1,
    "totalDebit": 1000,
    "totalCredit": 1000
  }
}
```

Then encode it:
```bash
cat envelope.json | base64 > envelope_base64.txt
```

Update `duplicate_event.json` with the base64 string, then POST:

```bash
curl -X POST https://cashflow-worker-291129507535.asia-southeast1.run.app/pubsub/push \
  -H "Content-Type: application/json" \
  -d @duplicate_event.json
```

### Option B: Use Pub/Sub Console

1. Go to [Google Cloud Console > Pub/Sub](https://console.cloud.google.com/cloudpubsub)
2. Select the `cashflow-events` topic
3. Find a message with your eventId
4. Click "Redeliver" or create a subscription and pull/ack the message

## Step 4: Check Worker Logs

```bash
gcloud logs read \
  "resource.type=cloud_run_revision AND resource.labels.service_name=cashflow-worker" \
  --limit=20 \
  --format="value(textPayload)" \
  --project=aiaccount-1c845
```

**You should see:**
- First time: `"Updating DailySummary"` with companyId, day, incomeDelta, expenseDelta
- Second time: `"Duplicate event detected, skipping (idempotent)"` with eventId

## Step 5: Verify DailySummary Didn't Double

Check the database again:

```sql
SELECT * FROM DailySummary 
WHERE companyId=1 
ORDER BY date DESC 
LIMIT 1;
```

**✅ Success Criteria:**
- `totalIncome` and `totalExpense` are **exactly the same** as Step 2
- They did **NOT** double

## Troubleshooting

### Worker not receiving events?

1. Check Pub/Sub subscription is configured to push to worker URL
2. Verify subscription has correct permissions
3. Check worker logs for errors

### Event processed but no DailySummary update?

1. Check if journal entry has income/expense accounts
2. Verify account types are INCOME or EXPENSE
3. Check worker logs for "No income/expense impact" message

### Duplicate not detected?

1. Verify `ProcessedEvent` table has unique constraint on `eventId`
2. Check that transaction is working correctly
3. Look for P2002 error in logs (should be caught and logged as warning)

