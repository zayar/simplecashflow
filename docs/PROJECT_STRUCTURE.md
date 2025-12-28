# Project Structure (non-breaking)

This doc explains **where things live** so the repo stays tidy without changing how you run/deploy.

## Top-level

- `src/`: Backend API (Fastify) + worker/publisher logic
- `prisma/`: Database schema + migrations
- `frontend/`: Main web app (Next.js)
- `mobile-pwa/`: Mobile PWA (Vite + React)
- `deploy/`: GCP deployment scripts + Cloud Build configs
- `scripts/`: One-off operational scripts (seed, migrations helpers, e2e scripts)
- `docs/`: Documentation (architecture, API standards, deployment)
- `test/`: Node test runner tests (`node --test`)

## Backend module layout (`src/`)

- `src/modules/books/`: “Books” domain (Invoices, Credit Notes, Expenses/Bills, etc.)
  - `books.routes.ts`: HTTP routes (thin controller)
  - `accounting/`: Pure accounting helpers (money math / invariants)
    - `invoiceAccounting.ts`: shared invoice math used by API + tests

## UI conventions

- Frontend and PWA should **reuse the API** (no duplicated business rules when avoidable).
- Invariants like tax/discount math should live in backend + tests (source of truth).


