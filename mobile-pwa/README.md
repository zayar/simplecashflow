# Cashflow Mobile PWA (Vite + React)

This is a standalone **PWA** project that uses the existing Cashflow backend API (Fastify).

## Prereqs

- Node.js 20+
- Backend running locally on `http://localhost:8080` (or set `VITE_API_URL`)

## Setup

```bash
cd mobile-pwa
npm install
cp env.example .env.local
npm run dev
```

Open the app at the URL shown by Vite (usually `http://localhost:5173`).

## Environment variables

- `VITE_API_URL`: Backend base URL (default: `http://localhost:8080`)

## Notes

- Auth: `POST /login` and `POST /register` return `{ token, user }`.
- Requests send `Authorization: Bearer <token>`.
- All non-GET requests automatically include `Idempotency-Key` for fintech safety.


