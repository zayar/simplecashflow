import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import { useAuth } from '../lib/auth';
import { getCustomers, getInvoices, type Customer, type InvoiceListRow } from '../lib/ar';
import { formatMMDDYYYY, formatMoneyK, toNumber, yearOf } from '../lib/format';
import { AppBar, GearIcon, IconButton } from '../components/AppBar';
import { BottomNav } from '../components/BottomNav';
import { Card } from '../components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs';

type ReportTab = 'invoice' | 'client';
type StatusTab = 'paid' | 'all';

function yearChips(nowYear: number): number[] {
  return [nowYear, nowYear - 1, nowYear - 2, nowYear - 3, nowYear - 4];
}

function isPaidOnly(statusTab: StatusTab): boolean {
  return statusTab === 'paid';
}

function filterInvoiceByStatus(inv: InvoiceListRow, statusTab: StatusTab): boolean {
  if (!isPaidOnly(statusTab)) return true;
  return String(inv.status).toUpperCase() === 'PAID';
}

export default function Reports() {
  const { user } = useAuth();
  const companyId = user?.companyId ?? 0;
  const navigate = useNavigate();

  const [tab, setTab] = useState<ReportTab>('invoice');
  const [statusTab, setStatusTab] = useState<StatusTab>('paid');
  const [year, setYear] = useState(() => new Date().getFullYear());

  const invoicesQuery = useQuery({
    queryKey: ['invoices', companyId],
    queryFn: async () => await getInvoices(companyId),
    enabled: companyId > 0
  });

  const customersQuery = useQuery({
    queryKey: ['customers', companyId],
    queryFn: async () => await getCustomers(companyId),
    enabled: companyId > 0
  });

  const selectedYearInvoices = useMemo(() => {
    const list = invoicesQuery.data ?? [];
    return list
      .filter((inv) => (yearOf(inv.invoiceDate) ?? year) === year)
      .filter((inv) => filterInvoiceByStatus(inv, statusTab))
      .slice()
      .sort((a, b) => (a.invoiceDate < b.invoiceDate ? 1 : -1));
  }, [invoicesQuery.data, year, statusTab]);

  const byClientRows = useMemo(() => {
    const customers = customersQuery.data ?? [];
    const invoices = selectedYearInvoices;

    const byId = new Map<number, { count: number; total: number }>();
    for (const inv of invoices) {
      const cid = (inv as any).customerId as number | null | undefined;
      if (!cid) continue;
      const prev = byId.get(cid) ?? { count: 0, total: 0 };
      prev.count += 1;
      prev.total += toNumber(inv.total);
      byId.set(cid, prev);
    }

    const merged = customers.map((c: Customer) => {
      const agg = byId.get(c.id) ?? { count: 0, total: 0 };
      return { customer: c, invoicesCount: agg.count, totalPaid: agg.total };
    });

    // Show only customers with activity in the chosen year/status.
    return merged.filter((r) => r.invoicesCount > 0).sort((a, b) => b.totalPaid - a.totalPaid);
  }, [customersQuery.data, selectedYearInvoices]);

  const totals = useMemo(() => {
    const invoices = selectedYearInvoices;
    const count = invoices.length;
    const total = invoices.reduce((sum, inv) => sum + toNumber(inv.total), 0);
    return { count, total };
  }, [selectedYearInvoices]);

  const years = useMemo(() => yearChips(new Date().getFullYear()), []);

  return (
    <div className="min-h-dvh bg-background">
      <AppBar
        title="Reports"
        left={
          <IconButton ariaLabel="Settings" onClick={() => navigate('/more')}>
            <GearIcon />
          </IconButton>
        }
        right={<div className="h-10 w-10" />}
      />

      <div className="mx-auto max-w-xl px-3 pb-24 pt-3">
        <Card className="rounded-2xl shadow-sm">
          <div className="p-3">
            <Tabs value={tab} onValueChange={(v) => setTab(v as ReportTab)} className="w-full">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="invoice">By Invoice</TabsTrigger>
                <TabsTrigger value="client">By Client</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          <div className="border-t border-border p-3">
            <Tabs value={statusTab} onValueChange={(v) => setStatusTab(v as StatusTab)} className="w-full">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="paid">Paid</TabsTrigger>
                <TabsTrigger value="all">All</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </Card>

        <Card className="mt-3 rounded-2xl shadow-sm">
          <div className="flex items-center gap-2 overflow-x-auto px-3 py-3">
            {years.map((y) => (
              <button
                key={y}
                type="button"
                onClick={() => setYear(y)}
                className={`shrink-0 rounded-xl border px-4 py-2 text-sm font-medium ${
                  y === year ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background text-foreground'
                }`}
              >
                {y}
              </button>
            ))}
          </div>
        </Card>

        <Card className="mt-3 overflow-hidden rounded-2xl shadow-sm">
          {invoicesQuery.isLoading || customersQuery.isLoading ? (
            <div className="p-4 text-sm text-muted-foreground">Loading…</div>
          ) : invoicesQuery.isError ? (
            <div className="p-4 text-sm text-destructive">Failed to load invoices.</div>
          ) : customersQuery.isError ? (
            <div className="p-4 text-sm text-destructive">Failed to load clients.</div>
          ) : (
            <div>
              <div className="flex items-center justify-between bg-muted px-4 py-2 text-sm text-muted-foreground">
                <div>Tax Year {year}</div>
                <div className="font-medium">{formatMoneyK(totals.total)}</div>
              </div>

              {tab === 'invoice' ? (
                selectedYearInvoices.length === 0 ? (
                  <div className="p-4 text-sm text-muted-foreground">No invoices for this period.</div>
                ) : (
                  selectedYearInvoices.map((inv) => (
                    <div key={inv.id} className="border-t border-border px-4 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-base text-foreground">
                            {inv.customerName ? String(inv.customerName) : 'No Client'}
                          </div>
                          <div className="text-sm text-muted-foreground">
                            {inv.invoiceNumber} • {formatMMDDYYYY(inv.invoiceDate)}
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="text-base font-medium text-foreground">{formatMoneyK(toNumber(inv.total))}</div>
                          <div className="text-sm text-muted-foreground">{String(inv.status).toUpperCase()}</div>
                        </div>
                      </div>
                    </div>
                  ))
                )
              ) : byClientRows.length === 0 ? (
                <div className="p-4 text-sm text-muted-foreground">No client activity for this period.</div>
              ) : (
                byClientRows.map((r) => (
                  <div key={r.customer.id} className="border-t border-border px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-base text-foreground">{r.customer.name}</div>
                        <div className="text-sm text-muted-foreground">
                          {r.invoicesCount} {r.invoicesCount === 1 ? 'invoice' : 'invoices'}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-base font-medium text-foreground">{formatMoneyK(r.totalPaid)}</div>
                        <div className="text-sm text-muted-foreground">Paid</div>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </Card>
      </div>

      <BottomNav />
    </div>
  );
}


