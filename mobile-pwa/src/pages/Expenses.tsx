import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import { useAuth } from '../lib/auth';
import { getExpenses, type ExpenseListRow } from '../lib/expenses';
import { formatMMDDYYYY, formatMoneyK, toNumber, yearOf } from '../lib/format';
import { AppBar, GearIcon, IconButton, SearchIcon } from '../components/AppBar';
import { BottomNav } from '../components/BottomNav';
import { Fab, PlusIcon } from '../components/Fab';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/input';

function statusLabel(status: string): { text: string; cls: string } {
  const s = String(status || '').toUpperCase();
  if (s === 'PAID') return { text: 'Paid', cls: 'text-emerald-600' };
  if (s === 'PARTIAL') return { text: 'Partial', cls: 'text-amber-600' };
  if (s === 'POSTED') return { text: 'Posted', cls: 'text-muted-foreground' };
  if (s === 'DRAFT') return { text: 'Draft', cls: 'text-muted-foreground' };
  return { text: s || '—', cls: 'text-muted-foreground' };
}

export default function Expenses() {
  const { user } = useAuth();
  const companyId = user?.companyId ?? 0;
  const navigate = useNavigate();
  const [searchOpen, setSearchOpen] = useState(false);
  const [q, setQ] = useState('');

  const expensesQuery = useQuery({
    queryKey: ['expenses', companyId],
    queryFn: async () => await getExpenses(companyId),
    enabled: companyId > 0
  });

  const filtered = useMemo(() => {
    const list = (expensesQuery.data ?? []) as ExpenseListRow[];
    const s = q.trim().toLowerCase();
    if (!s) return list;
    return list.filter((e) => {
      const vn = String(e.vendorName ?? '').toLowerCase();
      const num = String(e.expenseNumber ?? '').toLowerCase();
      return vn.includes(s) || num.includes(s);
    });
  }, [expensesQuery.data, q]);

  const grouped = useMemo(() => {
    const buckets = new Map<number, ExpenseListRow[]>();
    for (const e of filtered) {
      const y = yearOf(e.expenseDate) ?? new Date().getFullYear();
      const list = buckets.get(y) ?? [];
      list.push(e);
      buckets.set(y, list);
    }
    const years = Array.from(buckets.keys()).sort((a, b) => b - a);
    return years.map((y) => {
      const list = (buckets.get(y) ?? []).slice().sort((a, b) => (a.expenseDate < b.expenseDate ? 1 : -1));
      const total = list.reduce((sum, e) => sum + toNumber(e.amount), 0);
      return { year: y, total, expenses: list };
    });
  }, [filtered]);

  return (
    <div className="min-h-dvh bg-background">
      <AppBar
        title="Expenses"
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
          {searchOpen ? (
            <div className="p-3">
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search expenses…" />
            </div>
          ) : (
            <div className="p-3 text-sm text-muted-foreground">Track expenses and record outgoing payments.</div>
          )}
        </Card>

        <Card className="mt-3 overflow-hidden rounded-2xl shadow-sm">
          {expensesQuery.isLoading ? (
            <div className="p-4 text-sm text-muted-foreground">Loading…</div>
          ) : expensesQuery.isError ? (
            <div className="p-4 text-sm text-destructive">Failed to load expenses.</div>
          ) : grouped.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">No expenses yet.</div>
          ) : (
            <div>
              {grouped.map((g) => (
                <div key={g.year}>
                  <div className="flex items-center justify-between bg-muted px-4 py-2 text-sm text-muted-foreground">
                    <div>{g.year}</div>
                    <div className="font-medium">{formatMoneyK(g.total)}</div>
                  </div>
                  <div>
                    {g.expenses.map((e) => {
                      const vendor = e.vendorName ? String(e.vendorName) : 'No Vendor';
                      const meta = `${e.expenseNumber} • ${formatMMDDYYYY(e.expenseDate)}`;
                      const st = statusLabel(e.status);

                      return (
                        <div
                          key={e.id}
                          className="flex w-full items-start justify-between gap-3 border-t border-border px-4 py-3"
                        >
                          <div className="min-w-0">
                            <div className="truncate text-base text-foreground">{vendor}</div>
                            <div className="text-sm text-muted-foreground">{meta}</div>
                          </div>
                          <div className="shrink-0 text-right">
                            <div className="text-base font-medium text-foreground">{formatMoneyK(toNumber(e.amount))}</div>
                            <div className={`text-sm ${st.cls}`}>{st.text}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Fab onClick={() => navigate('/expenses/new')} ariaLabel="New expense" icon={<PlusIcon />} />
      <BottomNav />
    </div>
  );
}


