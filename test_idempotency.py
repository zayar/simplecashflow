#!/usr/bin/env python3
"""
Test Idempotency Script
Tests that duplicate events don't cause double-counting in DailySummary
"""

import requests
import json
import base64
import time
import sys
from datetime import datetime

API_URL = "https://cashflow-api-291129507535.asia-southeast1.run.app"
WORKER_URL = "https://cashflow-worker-291129507535.asia-southeast1.run.app"

def create_journal_entry(company_id, income_account_id, cash_account_id):
    """Create a journal entry via API"""
    print(f"\n{'='*50}")
    print("STEP 1: Creating Journal Entry")
    print(f"{'='*50}")
    
    payload = {
        "companyId": company_id,
        "date": datetime.utcnow().isoformat() + "Z",
        "description": "Test entry for idempotency verification",
        "lines": [
            {
                "accountId": income_account_id,
                "debit": 0,
                "credit": 1000  # Income of 1000
            },
            {
                "accountId": cash_account_id,
                "debit": 1000,
                "credit": 0
            }
        ]
    }
    
    print(f"POST {API_URL}/journal-entries")
    print(f"Payload: {json.dumps(payload, indent=2)}")
    
    response = requests.post(f"{API_URL}/journal-entries", json=payload)
    
    if response.status_code == 200:
        entry = response.json()
        print(f"✅ Journal Entry Created: ID {entry.get('id')}")
        return entry
    else:
        print(f"❌ Error: {response.status_code} - {response.text}")
        return None

def get_event_from_db(company_id):
    """Helper: Get the latest event from database (you'll need to run this manually)"""
    print(f"\n{'='*50}")
    print("STEP 2: Get Event Details from Database")
    print(f"{'='*50}")
    print("Run this SQL query to get the eventId:")
    print(f"  SELECT eventId, eventType, payload FROM Event WHERE companyId={company_id} ORDER BY createdAt DESC LIMIT 1;")
    print("\nOr check the Event table in your database directly.")
    return None

def simulate_duplicate_delivery(event_envelope):
    """Simulate duplicate event delivery to worker"""
    print(f"\n{'='*50}")
    print("STEP 3: Simulating Duplicate Delivery")
    print(f"{'='*50}")
    
    # Create Pub/Sub push message format
    envelope_json = json.dumps(event_envelope)
    envelope_base64 = base64.b64encode(envelope_json.encode('utf-8')).decode('utf-8')
    
    push_payload = {
        "message": {
            "data": envelope_base64
        }
    }
    
    print(f"POST {WORKER_URL}/pubsub/push")
    print(f"Event ID: {event_envelope.get('eventId')}")
    
    response = requests.post(f"{WORKER_URL}/pubsub/push", json=push_payload)
    
    if response.status_code == 204:
        print("✅ Worker responded (204 No Content)")
        return True
    else:
        print(f"❌ Error: {response.status_code} - {response.text}")
        return False

def check_logs():
    """Show how to check logs"""
    print(f"\n{'='*50}")
    print("STEP 4: Check Worker Logs")
    print(f"{'='*50}")
    print("Run this command to see worker logs:")
    print()
    print("gcloud logs read \\")
    print("  \"resource.type=cloud_run_revision AND resource.labels.service_name=cashflow-worker\" \\")
    print("  --limit=20 --format=\"value(textPayload)\"")
    print()
    print("You should see:")
    print("  - First time: 'Updating DailySummary'")
    print("  - Second time: 'Duplicate event detected, skipping (idempotent)'")

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 test_idempotency.py <companyId> [incomeAccountId] [cashAccountId]")
        print("\nExample: python3 test_idempotency.py 1")
        print("\nIf you don't provide account IDs, you'll need to:")
        print("  1. Query your database to get account IDs")
        print("  2. Or modify this script to fetch them automatically")
        sys.exit(1)
    
    company_id = int(sys.argv[1])
    
    # Try to get account IDs from command line or use defaults
    if len(sys.argv) >= 4:
        income_account_id = int(sys.argv[2])
        cash_account_id = int(sys.argv[3])
    else:
        print("\n⚠️  You need to provide account IDs.")
        print(f"Query your database:")
        print(f"  SELECT id, code, name FROM Account WHERE companyId={company_id} AND code IN ('4000', '1000');")
        print("\nThen run:")
        print(f"  python3 test_idempotency.py {company_id} <incomeAccountId> <cashAccountId>")
        sys.exit(1)
    
    # Step 1: Create journal entry
    entry = create_journal_entry(company_id, income_account_id, cash_account_id)
    if not entry:
        sys.exit(1)
    
    # Wait for processing
    print("\n⏳ Waiting 5 seconds for event processing...")
    time.sleep(5)
    
    # Step 2: Get event details
    print(f"\n{'='*50}")
    print("STEP 2: Check Initial State")
    print(f"{'='*50}")
    print("Check your database:")
    print(f"  SELECT * FROM DailySummary WHERE companyId={company_id} ORDER BY date DESC LIMIT 1;")
    print(f"  SELECT eventId, eventType, payload FROM Event WHERE companyId={company_id} ORDER BY createdAt DESC LIMIT 1;")
    print("\n⏸️  Press Enter after you've checked the database and have the eventId...")
    input()
    
    # Step 3: Get eventId from user
    event_id = input("Enter the eventId from the Event table: ").strip()
    journal_entry_id = input("Enter the journalEntryId from the payload: ").strip()
    
    # Construct event envelope
    event_envelope = {
        "eventId": event_id,
        "eventType": "journal.entry.created",
        "schemaVersion": "v1",
        "occurredAt": datetime.utcnow().isoformat() + "Z",
        "companyId": company_id,
        "source": "cashflow-api",
        "payload": {
            "journalEntryId": int(journal_entry_id),
            "companyId": company_id,
            "totalDebit": 1000,
            "totalCredit": 1000
        }
    }
    
    # Step 3: Simulate duplicate
    simulate_duplicate_delivery(event_envelope)
    
    # Step 4: Check logs
    check_logs()
    
    # Step 5: Final verification
    print(f"\n{'='*50}")
    print("STEP 5: Verify DailySummary Didn't Double")
    print(f"{'='*50}")
    print("Check your database again:")
    print(f"  SELECT * FROM DailySummary WHERE companyId={company_id} ORDER BY date DESC LIMIT 1;")
    print("\n✅ totalIncome and totalExpense should be the SAME as Step 2 (not doubled)")
    print("\n🎉 If totals didn't double, idempotency is working correctly!")

if __name__ == "__main__":
    main()

