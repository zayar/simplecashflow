import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchApi } from '../lib/api';
import { useAuth } from '../lib/auth';
import { TopBar } from '../components/TopBar';

type Company = { id: number; name: string };

export default function Dashboard() {
  const { user } = useAuth();
  const companyId = user?.companyId ?? 0;

  const companiesQuery = useQuery({
    queryKey: ['companies'],
    queryFn: async () => (await fetchApi('/companies')) as Company[],
    enabled: companyId > 0
  });

  const today = useMemo(() => {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }, []);

  const healthQuery = useQuery({
    queryKey: ['health'],
    queryFn: async () => await fetchApi('/health')
  });

  const companyName = companiesQuery.data?.[0]?.name ?? null;

  return (
    <div className="min-h-dvh">
      <TopBar title="Dashboard" />
      <div className="mx-auto max-w-xl px-4 py-4 safe-bottom">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/30 p-4">
          <div className="text-xs text-slate-400">Signed in as</div>
          <div className="mt-1 text-sm text-slate-100">{user?.email}</div>
          <div className="mt-1 text-xs text-slate-400">
            Company: {companyName ? companyName : `#${companyId}`}
          </div>
        </div>

        <div className="mt-4 grid gap-3">
          <div className="rounded-2xl border border-slate-800 bg-slate-950 p-4">
            <div className="text-sm font-semibold">Backend connectivity</div>
            <div className="mt-2 text-sm text-slate-300">
              {healthQuery.isLoading
                ? 'Checking /health…'
                : healthQuery.isError
                  ? 'Health check failed'
                  : 'OK'}
            </div>
          </div>

          {/* Settings Card */}
          <Link
            to="/settings"
            className="block rounded-2xl border border-slate-800 bg-slate-950 p-4 transition-colors hover:border-slate-700 hover:bg-slate-900"
          >
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold">Settings</div>
                <div className="mt-1 text-xs text-slate-400">Payment QR codes, preferences</div>
              </div>
              <svg className="h-5 w-5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </div>
          </Link>

          <div className="rounded-2xl border border-slate-800 bg-slate-950 p-4">
            <div className="text-sm font-semibold">Next: wire real screens</div>
            <ul className="mt-2 space-y-1 text-sm text-slate-300">
              <li>- Sales payments: GET /companies/{companyId}/sales/payments</li>
              <li>- Purchases payments: GET /companies/{companyId}/purchases/payments</li>
              <li>- Reports: trial balance / P&L / cashflow</li>
              <li>- Writes (post/pay/reverse) auto-send Idempotency-Key</li>
            </ul>
            <div className="mt-3 text-xs text-slate-500">Today: {today}</div>
          </div>

          {companiesQuery.isError ? (
            <div className="rounded-2xl border border-rose-900/60 bg-rose-950/30 p-4 text-sm text-rose-200">
              Could not load company info. Check that your token is valid and `VITE_API_URL` points to the API.
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}


