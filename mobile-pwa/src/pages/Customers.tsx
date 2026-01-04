import React, { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { getCustomers, getInvoices, type Customer, type InvoiceListRow } from '../lib/ar';
import { AppBar, BackIcon, IconButton, SearchIcon } from '../components/AppBar';
import { BottomNav } from '../components/BottomNav';
import { Fab, PlusIcon } from '../components/Fab';
import { formatMoneyK, toNumber } from '../lib/format';
import { getInvoiceDraft, setInvoiceDraft } from '../lib/invoiceDraft';

type Row = {
  customer: Customer;
  invoicesCount: number;
  totalBilled: number;
};

export default function Customers() {
  const { user } = useAuth();
  const companyId = user?.companyId ?? 0;
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const mode = params.get('mode'); // 'pick' or null
  const [q, setQ] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);

  const customersQuery = useQuery({
    queryKey: ['customers', companyId],
    queryFn: async () => await getCustomers(companyId),
    enabled: companyId > 0
  });

  const invoicesQuery = useQuery({
    queryKey: ['invoices', companyId],
    queryFn: async () => await getInvoices(companyId),
    enabled: companyId > 0
  });

  const rows = useMemo(() => {
    const customers = customersQuery.data ?? [];
    const invoices = invoicesQuery.data ?? [];

    const byId = new Map<number, { count: number; total: number }>();
    for (const inv of invoices) {
      const cid = (inv as any).customerId as number | null | undefined;
      if (!cid) continue;
      const prev = byId.get(cid) ?? { count: 0, total: 0 };
      prev.count += 1;
      prev.total += toNumber(inv.total);
      byId.set(cid, prev);
    }

    const merged: Row[] = customers.map((c) => {
      const agg = byId.get(c.id) ?? { count: 0, total: 0 };
      return { customer: c, invoicesCount: agg.count, totalBilled: agg.total };
    });

    const s = q.trim().toLowerCase();
    const filtered = s
      ? merged.filter((r) => String(r.customer.name ?? '').toLowerCase().includes(s))
      : merged;

    return filtered.sort((a, b) => b.totalBilled - a.totalBilled);
  }, [customersQuery.data, invoicesQuery.data, q]);

  function pickCustomer(c: Customer) {
    const draft = getInvoiceDraft();
    setInvoiceDraft({ ...draft, customerId: c.id, customerName: c.name });
    const returnTo = draft.returnTo ?? '/invoices/new';
    navigate(`${returnTo}?picked=1`, { replace: true });
  }

  return (
    <div className="min-h-dvh bg-slate-100">
      <AppBar
        title="Clients"
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
        {searchOpen ? (
          <div className="mb-3 rounded-lg bg-white p-3 shadow-sm">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search clients…"
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-[#4663F1]"
            />
          </div>
        ) : null}

        <div className="overflow-hidden rounded-lg bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2 text-xs text-slate-500">
            <div>Name</div>
            <div>Total Billed</div>
          </div>

          {customersQuery.isLoading ? (
            <div className="p-4 text-sm text-slate-500">Loading…</div>
          ) : customersQuery.isError ? (
            <div className="p-4 text-sm text-rose-600">Failed to load clients.</div>
          ) : rows.length === 0 ? (
            <div className="p-4 text-sm text-slate-500">No clients yet.</div>
          ) : (
            rows.map((r) => {
              const actionProps =
                mode === 'pick'
                  ? { onClick: () => pickCustomer(r.customer), role: 'button' as const }
                  : {
                      onClick: () => navigate(`/customers/${r.customer.id}`),
                      role: 'button' as const
                    };

              return (
                <button
                  key={r.customer.id}
                  type="button"
                  {...actionProps}
                  className="flex w-full items-center justify-between border-b border-slate-100 px-4 py-3 text-left active:bg-slate-50"
                >
                  <div className="min-w-0">
                    <div className="truncate text-base text-slate-900">{r.customer.name}</div>
                    <div className="text-sm text-slate-400">
                      {r.invoicesCount} {r.invoicesCount === 1 ? 'invoice' : 'invoices'}
                    </div>
                  </div>
                  <div className="shrink-0 text-right text-base font-medium text-slate-900">
                    {formatMoneyK(r.totalBilled)}
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>

      {mode ? null : <Fab onClick={() => navigate('/customers/new')} ariaLabel="New client" icon={<PlusIcon />} />}
      {mode ? null : <BottomNav />}
    </div>
  );
}


