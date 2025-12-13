#!/usr/bin/env python3
"""
Simulate Duplicate Event Delivery
Usage: python3 simulate_duplicate.py <eventId> <companyId> <journalEntryId>
"""

import requests
import json
import base64
import sys
from datetime import datetime

WORKER_URL = "https://cashflow-worker-291129507535.asia-southeast1.run.app"

def simulate_duplicate(event_id, company_id, journal_entry_id):
    """Simulate duplicate event delivery to worker"""
    
    # Create the event envelope
    envelope = {
        "eventId": event_id,
        "eventType": "journal.entry.created",
        "schemaVersion": "v1",
        "occurredAt": datetime.utcnow().isoformat() + "Z",
        "companyId": company_id,
        "source": "cashflow-api",
        "payload": {
            "journalEntryId": journal_entry_id,
            "companyId": company_id,
            "totalDebit": 1000,
            "totalCredit": 1000
        }
    }
    
    # Encode to base64
    envelope_json = json.dumps(envelope)
    envelope_base64 = base64.b64encode(envelope_json.encode('utf-8')).decode('utf-8')
    
    # Create Pub/Sub push message format
    push_payload = {
        "message": {
            "data": envelope_base64
        }
    }
    
    print(f"Sending duplicate event to worker...")
    print(f"  Event ID: {event_id}")
    print(f"  Company ID: {company_id}")
    print(f"  Journal Entry ID: {journal_entry_id}")
    print()
    
    # POST to worker
    response = requests.post(f"{WORKER_URL}/pubsub/push", json=push_payload)
    
    print(f"Response Status: {response.status_code}")
    
    if response.status_code == 204:
        print("✅ Worker responded (204 No Content)")
        print()
        print("Now check the worker logs to see:")
        print("  'Duplicate event detected, skipping (idempotent)'")
        print()
        print("And verify in database that DailySummary totals didn't change.")
    else:
        print(f"❌ Error: {response.text}")
        return False
    
    return True

if __name__ == "__main__":
    if len(sys.argv) != 4:
        print("Usage: python3 simulate_duplicate.py <eventId> <companyId> <journalEntryId>")
        print()
        print("Example:")
        print("  python3 simulate_duplicate.py abc-123-def-456 1 42")
        sys.exit(1)
    
    event_id = sys.argv[1]
    company_id = int(sys.argv[2])
    journal_entry_id = int(sys.argv[3])
    
    simulate_duplicate(event_id, company_id, journal_entry_id)

