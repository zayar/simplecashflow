# Idempotency Test Results & Action Plan

## Test Execution Summary

**Date:** 2025-12-12  
**Status:** ⚠️ Database Connectivity Issue Detected

### Findings

1. **API Health Check:** ✅ PASSED
   - API endpoint is responding correctly
   - Service is running at: `https://cashflow-api-291129507535.asia-southeast1.run.app`

2. **Database Connectivity:** ❌ FAILED
   - Cloud Run services cannot reach Cloud SQL database at `34.87.113.215:3306`
   - Error: "Can't reach database server"
   - This affects both API and Worker services

3. **Worker Service:** ✅ DEPLOYED
   - Worker is deployed and running
   - URL: `https://cashflow-worker-291129507535.asia-southeast1.run.app`
   - Cannot verify functionality due to database connectivity

## Root Cause

The Cloud SQL database is not accessible from Cloud Run services. This is typically due to:

1. **Missing Authorized Networks:** Cloud SQL needs to allow connections from Cloud Run
2. **Missing Cloud SQL Proxy:** Should use Cloud SQL Proxy connection instead of direct IP
3. **Network Configuration:** VPC/network settings may be blocking connections

## Required Fixes

### Option 1: Use Cloud SQL Proxy (Recommended)

Update your Cloud Run services to use Cloud SQL Proxy connection string:

```bash
# Instead of: mysql://root:P@ssw0rd@34.87.113.215:3306/cashflow_prod
# Use: mysql://root:P@ssw0rd@/cashflow_prod?unix_socket=/cloudsql/PROJECT_ID:REGION:INSTANCE_NAME

# Example:
DATABASE_URL="mysql://root:P@ssw0rd@/cashflow_prod?unix_socket=/cloudsql/aiaccount-1c845:asia-southeast1:cashflow-db"
```

Then redeploy with:
```bash
gcloud run deploy cashflow-api \
  --image gcr.io/$PROJECT_ID/cashflow-api \
  --region=asia-southeast1 \
  --add-cloudsql-instances=$PROJECT_ID:asia-southeast1:cashflow-db \
  --set-env-vars="DATABASE_URL=mysql://root:P@ssw0rd@/cashflow_prod?unix_socket=/cloudsql/aiaccount-1c845:asia-southeast1:cashflow-db,..."
```

### Option 2: Authorize Cloud Run IPs

1. Go to Cloud SQL Console
2. Select your instance
3. Go to "Connections" tab
4. Add authorized networks (Cloud Run uses dynamic IPs, so this is less ideal)

## Testing Plan (After Fix)

Once database connectivity is fixed, follow these steps:

### Step 1: Create Journal Entry

```bash
# First, get account IDs
curl https://cashflow-api-291129507535.asia-southeast1.run.app/companies/1/accounts

# Then create entry
curl -X POST https://cashflow-api-291129507535.asia-southeast1.run.app/journal-entries \
  -H "Content-Type: application/json" \
  -d '{
    "companyId": 1,
    "date": "2025-12-12T10:00:00Z",
    "description": "Idempotency test",
    "lines": [
      {"accountId": <INCOME_ID>, "debit": 0, "credit": 1000},
      {"accountId": <CASH_ID>, "debit": 1000, "credit": 0}
    ]
  }'
```

### Step 2: Check Initial State

```sql
-- Get eventId
SELECT eventId, payload FROM Event 
WHERE companyId=1 
ORDER BY createdAt DESC LIMIT 1;

-- Check initial DailySummary
SELECT * FROM DailySummary 
WHERE companyId=1 
ORDER BY date DESC LIMIT 1;
```

### Step 3: Simulate Duplicate

```bash
python3 simulate_duplicate.py <eventId> 1 <journalEntryId>
```

### Step 4: Verify Idempotency

```sql
-- Check DailySummary again - should be same as Step 2
SELECT * FROM DailySummary 
WHERE companyId=1 
ORDER BY date DESC LIMIT 1;
```

### Step 5: Check Logs

```bash
# Use Cloud Console Logs Explorer or:
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=cashflow-worker" \
  --limit=20 \
  --project=aiaccount-1c845
```

Look for:
- ✅ "Updating DailySummary" (first delivery)
- ✅ "Duplicate event detected, skipping (idempotent)" (duplicate delivery)

## Test Scripts Available

1. **`run_test.sh`** - Comprehensive test suite
2. **`simulate_duplicate.py`** - Simulate duplicate event delivery
3. **`TESTING_GUIDE.md`** - Detailed manual testing guide

## Next Steps

1. **Fix database connectivity** (use Cloud SQL Proxy)
2. **Redeploy services** with correct DATABASE_URL
3. **Run test suite** using `./run_test.sh 1`
4. **Verify idempotency** using the steps above

## Expected Results (After Fix)

✅ Journal entry created successfully  
✅ Event stored in Event table with eventId  
✅ DailySummary updated with correct totals  
✅ Duplicate event delivery detected and skipped  
✅ DailySummary totals remain unchanged  
✅ Worker logs show idempotency message  

