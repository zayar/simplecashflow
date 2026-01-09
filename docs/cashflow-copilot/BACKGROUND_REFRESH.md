# Cashflow Copilot: background refresh + nightly job

Cashflow Copilot forecasts are always computable on-demand via:

- `GET /companies/:companyId/cashflow/forecast`

To make dashboards faster and keep forecasts warm in the background, we also maintain cached snapshots.

## 1) DB migration

Apply Prisma migrations so the snapshot table exists:

- Dev: `npx prisma migrate dev`
- Prod: `npx prisma migrate deploy`

## 2) Background refresh triggers (event-driven)

The worker listens to Pub/Sub events and already consumes:

- `journal.entry.created`

On each journal entry creation, the worker refreshes cached cashflow snapshots for that company (base/conservative/optimistic).

This keeps forecasts up-to-date after:

- invoice posting / payments
- bill posting / payments
- banking transactions that create journal entries

## 3) Nightly job (Cloud Scheduler)

The worker exposes a protected endpoint:

- `GET /jobs/cashflow/nightly`

### Required config

Set this env var on the **worker** service:

- `CASHFLOW_JOB_TOKEN=<long-random-secret>`

### Cloud Scheduler setup

Create a Cloud Scheduler job (daily) that hits the worker URL:

- URL: `https://<cashflow-worker-url>/jobs/cashflow/nightly`
- Method: `GET`
- Headers:
  - `X-Job-Token: <same secret as CASHFLOW_JOB_TOKEN>`

The endpoint returns:

```json
{ "status": "ok", "companies": 10, "refreshed": 10, "failed": 0 }
```

