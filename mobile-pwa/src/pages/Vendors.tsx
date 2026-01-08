import React, { useMemo, useState, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { getVendors, getExpenses, type Vendor, type ExpenseListRow } from '../lib/expenses';
import { AppBar, BackIcon, IconButton, SearchIcon } from '../components/AppBar';
import { BottomNav } from '../components/BottomNav';
import { Fab, PlusIcon } from '../components/Fab';
import { formatMoneyK, toNumber } from '../lib/format';
import { usePullToRefresh } from '../lib/usePullToRefresh';
import { PullToRefreshIndicator } from '../components/PullToRefresh';

type Row = {
  vendor: Vendor;
  expensesCount: number;
  totalSpent: number;
};

export default function Vendors() {
  const { user } = useAuth();
  const companyId = user?.companyId ?? 0;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const mode = params.get('mode'); // 'pick' or null
  const [q, setQ] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);

  const vendorsQuery = useQuery({
    queryKey: ['vendors', companyId],
    queryFn: async () => await getVendors(companyId),
    enabled: companyId > 0
  });

  const expensesQuery = useQuery({
    queryKey: ['expenses', companyId],
    queryFn: async () => await getExpenses(companyId),
    enabled: companyId > 0
  });

  const handleRefresh = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['vendors', companyId] }),
      queryClient.invalidateQueries({ queryKey: ['expenses', companyId] })
    ]);
  }, [queryClient, companyId]);

  const { isRefreshing, pullDistance, handlers, containerRef } = usePullToRefresh({
    onRefresh: handleRefresh
  });

  const rows = useMemo(() => {
    const vendors = vendorsQuery.data ?? [];
    const expenses = expensesQuery.data ?? [];

    const byId = new Map<number, { count: number; total: number }>();
    for (const exp of expenses) {
      const vid = exp.vendorId;
      if (!vid) continue;
      const prev = byId.get(vid) ?? { count: 0, total: 0 };
      prev.count += 1;
      prev.total += toNumber(exp.amount);
      byId.set(vid, prev);
    }

    const merged: Row[] = vendors.map((v) => {
      const agg = byId.get(v.id) ?? { count: 0, total: 0 };
      return { vendor: v, expensesCount: agg.count, totalSpent: agg.total };
    });

    const s = q.trim().toLowerCase();
    const filtered = s
      ? merged.filter((r) => String(r.vendor.name ?? '').toLowerCase().includes(s))
      : merged;

    return filtered.sort((a, b) => b.totalSpent - a.totalSpent);
  }, [vendorsQuery.data, expensesQuery.data, q]);

  function pickVendor(v: Vendor) {
    // For expense forms, store selected vendor in sessionStorage and navigate back
    try {
      sessionStorage.setItem('picked_vendor', JSON.stringify({ id: v.id, name: v.name }));
    } catch {}
    navigate(-1);
  }

  return (
    <div
      className="min-h-dvh bg-slate-100"
      ref={containerRef}
      {...handlers}
    >
      <AppBar
        title="Vendors"
        left={
          <IconButton ariaLabel="Back" onClick={() => navigate(-1)}>
            <BackIcon />
          </IconButton>
        }
        right={
          <IconButton ariaLabel="Search" onClick={() => setSearchOpen((v) => !v)}>
            <SearchIcon />
          </IconButton>
        }
      />

      <div className="mx-auto max-w-xl px-3 pb-24 pt-3">
        <PullToRefreshIndicator isRefreshing={isRefreshing} pullDistance={pullDistance} />

        {searchOpen ? (
          <div className="mb-3 rounded-lg bg-white p-3 shadow-sm">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search vendors…"
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-[#4663F1]"
            />
          </div>
        ) : null}

        <div className="overflow-hidden rounded-lg bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2 text-xs text-slate-500">
            <div>Name</div>
            <div>Total Spent</div>
          </div>

          {vendorsQuery.isLoading ? (
            <div className="p-4 text-sm text-slate-500">Loading…</div>
          ) : vendorsQuery.isError ? (
            <div className="p-4 text-sm text-rose-600">Failed to load vendors.</div>
          ) : rows.length === 0 ? (
            <div className="p-4 text-sm text-slate-500">No vendors yet.</div>
          ) : (
            rows.map((r) => {
              const actionProps =
                mode === 'pick'
                  ? { onClick: () => pickVendor(r.vendor), role: 'button' as const }
                  : {
                      onClick: () => navigate(`/vendors/${r.vendor.id}`),
                      role: 'button' as const
                    };

              return (
                <button
                  key={r.vendor.id}
                  type="button"
                  {...actionProps}
                  className="flex w-full items-center justify-between border-b border-slate-100 px-4 py-3 text-left active:bg-slate-50"
                >
                  <div className="min-w-0">
                    <div className="truncate text-base text-slate-900">{r.vendor.name}</div>
                    <div className="text-sm text-slate-400">
                      {r.expensesCount} {r.expensesCount === 1 ? 'expense' : 'expenses'}
                    </div>
                  </div>
                  <div className="shrink-0 text-right text-base font-medium text-slate-900">
                    {formatMoneyK(r.totalSpent)}
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>

      <Fab
        onClick={() => {
          if (mode === 'pick') {
            navigate('/vendors/new?mode=pick');
            return;
          }
          navigate('/vendors/new');
        }}
        ariaLabel="New vendor"
        icon={<PlusIcon />}
      />
      {mode ? null : <BottomNav />}
    </div>
  );
}

