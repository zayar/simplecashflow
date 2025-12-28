import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { getInvoices, type InvoiceListRow } from '../lib/ar';
import { formatMMDDYYYY, formatMoneyK, toNumber, yearOf } from '../lib/format';
import { AppBar, GearIcon, IconButton, SearchIcon } from '../components/AppBar';
import { BottomNav } from '../components/BottomNav';
import { Fab, PlusIcon } from '../components/Fab';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs';

type TabKey = 'all' | 'outstanding' | 'paid';

function filterByTab(tab: TabKey, inv: InvoiceListRow): boolean {
  if (tab === 'paid') return inv.status === 'PAID';
  if (tab === 'outstanding') return inv.status !== 'PAID';
  return true;
}

export default function Invoices() {
  const { user } = useAuth();
  const companyId = user?.companyId ?? 0;
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabKey>('all');
  const [searchOpen, setSearchOpen] = useState(false);
  const [q, setQ] = useState('');

  const invoicesQuery = useQuery({
    queryKey: ['invoices', companyId],
    queryFn: async () => await getInvoices(companyId),
    enabled: companyId > 0
  });

  const filtered = useMemo(() => {
    const list = (invoicesQuery.data ?? []).filter((inv) => filterByTab(tab, inv));
    const s = q.trim().toLowerCase();
    if (!s) return list;
    return list.filter((inv) => {
      const cn = String(inv.customerName ?? '').toLowerCase();
      const num = String(inv.invoiceNumber ?? '').toLowerCase();
      return cn.includes(s) || num.includes(s);
    });
  }, [invoicesQuery.data, tab, q]);

  const grouped = useMemo(() => {
    const buckets = new Map<number, InvoiceListRow[]>();
    for (const inv of filtered) {
      const y = yearOf(inv.invoiceDate) ?? new Date().getFullYear();
      const list = buckets.get(y) ?? [];
      list.push(inv);
      buckets.set(y, list);
    }
    const years = Array.from(buckets.keys()).sort((a, b) => b - a);
    return years.map((y) => {
      const list = (buckets.get(y) ?? []).slice().sort((a, b) => (a.invoiceDate < b.invoiceDate ? 1 : -1));
      const total = list.reduce((sum, inv) => sum + toNumber(inv.total), 0);
      return { year: y, total, invoices: list };
    });
  }, [filtered]);

  return (
    <div className="min-h-dvh bg-background">
      <AppBar
        title="Invoices"
        left={
          <IconButton ariaLabel="Settings" onClick={() => navigate('/more')}>
            <GearIcon />
          </IconButton>
        }
        right={
          <IconButton ariaLabel="Search" onClick={() => setSearchOpen((v) => !v)}>
            <SearchIcon />
          </IconButton>
        }
      />

      <div className="mx-auto max-w-xl px-3 pb-24 pt-3">
        <Card className="rounded-2xl shadow-sm">
          <div className="p-3">
            <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)} className="w-full">
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="all">All</TabsTrigger>
                <TabsTrigger value="outstanding">Outstanding</TabsTrigger>
                <TabsTrigger value="paid">Paid</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

          {searchOpen ? (
            <div className="border-t border-border p-3">
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search invoices…" />
            </div>
          ) : null}
        </Card>

        <Card className="mt-3 overflow-hidden rounded-2xl shadow-sm">
          {invoicesQuery.isLoading ? (
            <div className="p-4 text-sm text-muted-foreground">Loading…</div>
          ) : invoicesQuery.isError ? (
            <div className="p-4 text-sm text-destructive">Failed to load invoices.</div>
          ) : grouped.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">No invoices yet.</div>
          ) : (
            <div>
              {grouped.map((g) => (
                <div key={g.year}>
                  <div className="flex items-center justify-between bg-muted px-4 py-2 text-sm text-muted-foreground">
                    <div>{g.year}</div>
                    <div className="font-medium">{formatMoneyK(g.total)}</div>
                  </div>
                  <div>
                    {g.invoices.map((inv) => {
                      const customer = inv.customerName ? String(inv.customerName) : 'No Client';
                      const secondary =
                        inv.status === 'PAID'
                          ? `Paid`
                          : inv.dueDate
                            ? `Due ${formatMMDDYYYY(inv.dueDate)}`
                            : inv.status === 'DRAFT'
                              ? 'Draft'
                              : 'Outstanding';

                      return (
                        <button
                          key={inv.id}
                          type="button"
                          onClick={() => navigate(`/invoices/${inv.id}`)}
                          className="flex w-full items-start justify-between gap-3 border-t border-border px-4 py-3 text-left active:bg-muted/50"
                        >
                          <div className="min-w-0">
                            <div className="truncate text-base text-foreground">{customer}</div>
                            <div className="text-sm text-muted-foreground">{inv.invoiceNumber}</div>
                          </div>
                          <div className="shrink-0 text-right">
                            <div className="text-base font-medium text-foreground">{formatMoneyK(inv.total)}</div>
                            <div className={`text-sm ${inv.status === 'PAID' ? 'text-emerald-600' : 'text-muted-foreground'}`}>
                              {secondary}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Fab onClick={() => navigate('/invoices/new')} ariaLabel="New invoice" icon={<PlusIcon />} />
      <BottomNav />
    </div>
  );
}


