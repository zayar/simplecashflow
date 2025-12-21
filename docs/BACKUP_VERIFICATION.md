## Backup verification (production go-live gate)

Backups are only “real” if you can **restore** them and the restored system passes basic correctness checks.

This repo includes a helper script (`scripts/backup_restore_verify.sh`) to run a **restore drill** into a staging environment.

### What this verifies

- **Restore works** (Cloud SQL clone/restore completes)
- **Schema/migrations are coherent** (basic queries succeed)
- **Core bookkeeping invariants hold** (no obvious corruption)
- **App smoke checks pass** (optional)

### Required GCP access

- Cloud SQL Admin on the target project (or minimum permissions to create clone instances + read backups)
- Ability to connect to the restored DB (Cloud SQL Proxy or private connectivity)

### Runbook (recommended cadence)

- **Weekly** on staging data
- **Monthly** full production restore drill (controlled window)

### RPO / RTO checklist (fill this in)

- **RPO**: ____ minutes/hours (maximum acceptable data loss)
- **RTO**: ____ minutes/hours (maximum acceptable downtime)
- **Last drill date**: ____
- **Last drill outcome**: ____

### How to run

1) Ensure you have `gcloud` installed and authenticated.
2) Export required env vars (see script header).
3) Run:

```bash
./scripts/backup_restore_verify.sh
```

### What “pass” means (minimum)

- Restored instance exists and is reachable.
- These queries succeed and return plausible values:
  - row counts for key tables (Company, Invoice, Payment, StockMove, PurchaseBill)
  - newest rows exist in expected ranges
- Optional: run an API smoke test against a staging deployment pointing at the restored DB.


