import React, { useMemo, useState, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { getItems, type Item } from '../lib/ar';
import { AppBar, BackIcon, IconButton, SearchIcon } from '../components/AppBar';
import { BottomNav } from '../components/BottomNav';
import { Fab, PlusIcon } from '../components/Fab';
import { formatMoneyK, toNumber } from '../lib/format';
import { getInvoiceDraft, setInvoiceDraft } from '../lib/invoiceDraft';
import { usePullToRefresh } from '../lib/usePullToRefresh';
import { PullToRefreshIndicator } from '../components/PullToRefresh';

export default function Items() {
  const { user } = useAuth();
  const companyId = user?.companyId ?? 0;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const mode = params.get('mode'); // 'pick' or null
  const [q, setQ] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);

  const itemsQuery = useQuery({
    queryKey: ['items', companyId],
    queryFn: async () => await getItems(companyId),
    enabled: companyId > 0
  });

  const handleRefresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['items', companyId] });
  }, [queryClient, companyId]);

  const { isRefreshing, pullDistance, handlers, containerRef } = usePullToRefresh({
    onRefresh: handleRefresh
  });

  const rows = useMemo(() => {
    const items = itemsQuery.data ?? [];
    const s = q.trim().toLowerCase();
    const filtered = s ? items.filter((i) => String(i.name ?? '').toLowerCase().includes(s)) : items;
    return filtered.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }, [itemsQuery.data, q]);

  function pickItem(item: Item) {
    const draft = getInvoiceDraft();
    const idx = Number(draft.activeLineIndex ?? 0);
    const safeIdx = Number.isFinite(idx) && idx >= 0 ? idx : 0;
    const nextLines = draft.lines.map((l, i) => {
      if (i !== safeIdx) return l;
      return {
        ...l,
        itemId: item.id,
        itemName: item.name,
        // Allow free items: if API has null/0 sellingPrice, keep 0.
        unitPrice: Math.max(0, toNumber(item.sellingPrice))
      };
    });
    const returnTo = draft.returnTo ?? '/invoices/new';
    setInvoiceDraft({ ...draft, lines: nextLines, activeLineIndex: null, returnTo: null });
    const sep = returnTo.includes('?') ? '&' : '?';
    navigate(`${returnTo}${sep}picked=1`, { replace: true });
  }

  return (
    <div
      className="min-h-dvh bg-slate-100"
      ref={containerRef}
      {...handlers}
    >
      <AppBar
        title="Items"
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
              placeholder="Search items…"
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-[#4663F1]"
            />
          </div>
        ) : null}

        <div className="overflow-hidden rounded-lg bg-white shadow-sm">
          {itemsQuery.isLoading ? (
            <div className="p-4 text-sm text-slate-500">Loading…</div>
          ) : itemsQuery.isError ? (
            <div className="p-4 text-sm text-rose-600">Failed to load items.</div>
          ) : rows.length === 0 ? (
            <div className="p-4 text-sm text-slate-500">No items yet.</div>
          ) : (
            rows.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => (mode === 'pick' ? pickItem(item) : navigate(`/items/${item.id}`))}
                className="flex w-full items-center justify-between border-b border-slate-100 px-4 py-3 text-left active:bg-slate-50"
              >
                <div className="min-w-0">
                  <div className="truncate text-base text-slate-900">{item.name}</div>
                  <div className="text-sm text-slate-400">{item.sku ? item.sku : item.type}</div>
                </div>
                <div className="shrink-0 text-right text-base font-medium text-slate-900">
                  {formatMoneyK(item.sellingPrice ?? 0)}
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      <Fab
        onClick={() => {
          if (mode === 'pick') {
            const draft = getInvoiceDraft();
            const returnTo = draft.returnTo ?? '/invoices/new';
            navigate(`/items/new?mode=pick&returnTo=${encodeURIComponent(returnTo)}`);
            return;
          }
          navigate('/items/new');
        }}
        ariaLabel="New item"
        icon={<PlusIcon />}
      />
      {mode ? null : <BottomNav />}
    </div>
  );
}


