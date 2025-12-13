#!/usr/bin/env python3
"""
End-to-End Idempotency Test
"""
import requests
import json
import base64
import time
import sys
from datetime import datetime

API_URL = "https://cashflow-api-291129507535.asia-southeast1.run.app"
WORKER_URL = "https://cashflow-worker-291129507535.asia-southeast1.run.app"
COMPANY_ID = 1

def get_pnl():
    """Get PnL report to check totals"""
    today = datetime.utcnow().strftime('%Y-%m-%d')
    start_of_month = datetime.utcnow().strftime('%Y-%m-01')
    
    # We'll check from start of month to today
    resp = requests.get(f"{API_URL}/reports/pnl?companyId={COMPANY_ID}&from={start_of_month}&to={today}")
    if resp.status_code == 200:
        return resp.json()
    else:
        print(f"Error getting PnL: {resp.text}")
        return None

def main():
    print(f"Checking baseline PnL for Company {COMPANY_ID}...")
    baseline = get_pnl()
    if not baseline:
        sys.exit(1)
        
    print(f"Baseline Income: {baseline.get('totalIncome')}")
    print(f"Baseline Expense: {baseline.get('totalExpense')}")
    print()

    # Step 1: Create Journal Entry via API
    print("Creating new Journal Entry...")
    # Get accounts first
    accounts_resp = requests.get(f"{API_URL}/companies/{COMPANY_ID}/accounts")
    if accounts_resp.status_code != 200:
        print("Failed to get accounts")
        sys.exit(1)
        
    accounts = accounts_resp.json()
    income_acc = next((a for a in accounts if a['code'] == '4000'), None)
    cash_acc = next((a for a in accounts if a['code'] == '1000'), None)
    
    if not income_acc or not cash_acc:
        print("Required accounts not found")
        sys.exit(1)

    entry_payload = {
        "companyId": COMPANY_ID,
        "date": datetime.utcnow().isoformat() + "Z",
        "description": f"E2E Idempotency Test {int(time.time())}",
        "lines": [
            {"accountId": income_acc['id'], "debit": 0, "credit": 100},
            {"accountId": cash_acc['id'], "debit": 100, "credit": 0}
        ]
    }
    
    entry_resp = requests.post(f"{API_URL}/journal-entries", json=entry_payload)
    if entry_resp.status_code != 200:
        print(f"Failed to create entry: {entry_resp.text}")
        sys.exit(1)
        
    entry_data = entry_resp.json()
    entry_id = entry_data['id']
    print(f"Created Entry ID: {entry_id}")
    
    # Wait for processing
    print("Waiting 10s for worker processing...")
    time.sleep(10)
    
    # Check new totals
    updated = get_pnl()
    print(f"Updated Income: {updated.get('totalIncome')} (Expected +100)")
    
    # Verify increase
    if updated['totalIncome'] != baseline['totalIncome'] + 100:
        print("⚠️  Warning: Income did not increase by 100 yet (worker lag?)")
    else:
        print("✅ Income updated correctly.")
        
    # Step 2: Simulate Duplicate
    # We need the eventId. Since we can't query DB, we'll make up a fake one or reuse one if we knew it.
    # Actually, to properly test idempotency, we need the EXACT eventId that was just generated.
    # But the API doesn't return the eventId in the response (it returns the Entry).
    # However, for this test, let's construct a NEW event but send it TWICE manually.
    # The worker logic dedups based on eventId.
    
    print("\nSimulating Duplicate Delivery (Sending same eventId twice)...")
    test_event_id = f"test-dedup-{int(time.time())}"
    
    envelope = {
        "eventId": test_event_id,
        "eventType": "journal.entry.created",
        "schemaVersion": "v1",
        "occurredAt": datetime.utcnow().isoformat() + "Z",
        "companyId": COMPANY_ID,
        "source": "manual-test",
        "payload": {
            "journalEntryId": entry_id, # Reuse the entry we just made
            "companyId": COMPANY_ID,
            "totalDebit": 100,
            "totalCredit": 100
        }
    }
    
    # Send First Time
    print(f"Sending Event {test_event_id} (Attempt 1)...")
    push_payload = {"message": {"data": base64.b64encode(json.dumps(envelope).encode()).decode()}}
    r1 = requests.post(f"{WORKER_URL}/pubsub/push", json=push_payload)
    print(f"Response: {r1.status_code}")
    
    time.sleep(2)
    
    # Check if this added ANOTHER 100?
    # Since we reused the journalEntryId, the worker will load that entry (100 income) and add it again to summary.
    # So if this event is processed, Income should go up by ANOTHER 100.
    
    after_manual_1 = get_pnl()
    print(f"Income after manual push 1: {after_manual_1.get('totalIncome')}")
    
    # Send Second Time (Duplicate)
    print(f"Sending Event {test_event_id} (Attempt 2 - Duplicate)...")
    r2 = requests.post(f"{WORKER_URL}/pubsub/push", json=push_payload)
    print(f"Response: {r2.status_code}")
    
    time.sleep(2)
    
    after_manual_2 = get_pnl()
    print(f"Income after manual push 2: {after_manual_2.get('totalIncome')}")
    
    if after_manual_1['totalIncome'] == after_manual_2['totalIncome']:
        print("\n✅ SUCCESS: Totals did not change after duplicate delivery!")
    else:
        print("\n❌ FAILURE: Totals changed! Idempotency failed.")

if __name__ == "__main__":
    main()

