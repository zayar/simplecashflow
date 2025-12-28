# Development workflow (safe defaults)

## Backend (API)

From repo root:

```bash
npm install
npm run dev
```

API default: `http://localhost:8080`

## Web app (Next.js)

```bash
cd frontend
npm install
npm run dev
```

## Mobile PWA (Vite)

```bash
cd mobile-pwa
npm install
cp env.example .env.local
npm run dev
```

Set API URL via `VITE_API_URL`.

## Tests (accounting invariants)

From repo root:

```bash
npm test
```

## Deploy (GCP)

- Web frontend: `./deploy/deploy_frontend_only.sh`
- Mobile PWA: `./deploy/deploy_mobile_pwa.sh`


