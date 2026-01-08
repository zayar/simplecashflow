import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useAuth } from '../lib/auth';
import { getExpense } from '../lib/expenses';
import { formatMMDDYYYY, formatMoneyK, toNumber } from '../lib/format';
import { AppBar, BackIcon, IconButton } from '../components/AppBar';
import { Card } from '../components/ui/card';
import { Button } from '../components/ui/button';

function statusLabel(status: string): { text: string; cls: string } {
  const s = String(status || '').toUpperCase();
  if (s === 'PAID') return { text: 'Paid', cls: 'text-emerald-600' };
  if (s === 'PARTIAL') return { text: 'Partial', cls: 'text-amber-600' };
  if (s === 'POSTED') return { text: 'Posted', cls: 'text-muted-foreground' };
  if (s === 'APPROVED') return { text: 'Approved', cls: 'text-muted-foreground' };
  if (s === 'VOID') return { text: 'Void', cls: 'text-rose-600' };
  if (s === 'DRAFT') return { text: 'Draft', cls: 'text-muted-foreground' };
  return { text: s || '—', cls: 'text-muted-foreground' };
}

export default function ExpenseDetail() {
  const { user } = useAuth();
  const companyId = user?.companyId ?? 0;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const params = useParams();
  const expenseId = Number(params.id ?? 0);

  const expenseQuery = useQuery({
    queryKey: ['expense', companyId, expenseId],
    queryFn: async () => await getExpense(companyId, expenseId),
    enabled: companyId > 0 && expenseId > 0,
  });

  const exp = expenseQuery.data ?? null;
  const vendorName =
    exp?.vendorName ? String(exp.vendorName) : exp?.vendorId ? `Vendor #${exp.vendorId}` : 'No Vendor';
  const st = statusLabel(exp?.status ?? '');
  const canEdit = String(exp?.status ?? '').toUpperCase() === 'DRAFT';

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['expense', companyId, expenseId] });
    await queryClient.invalidateQueries({ queryKey: ['expenses', companyId] });
  }

  return (
    <div className="min-h-dvh bg-background">
      <AppBar
        title="Expense"
        left={
          <IconButton ariaLabel="Back" onClick={() => navigate(-1)}>
            <BackIcon />
          </IconButton>
        }
        right={
          <IconButton
            ariaLabel="Refresh"
            onClick={() => {
              refresh().catch(() => {});
            }}
          >
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-3-6.7M21 3v6h-6" />
            </svg>
          </IconButton>
        }
      />

      <div className="mx-auto max-w-xl px-3 py-3 space-y-3">
        {expenseQuery.isLoading ? (
          <Card className="rounded-2xl p-4 text-sm text-muted-foreground shadow-sm">Loading…</Card>
        ) : expenseQuery.isError ? (
          <Card className="rounded-2xl p-4 text-sm text-destructive shadow-sm">Failed to load expense.</Card>
        ) : !exp ? (
          <Card className="rounded-2xl p-4 text-sm text-muted-foreground shadow-sm">Not found.</Card>
        ) : (
          <>
            <Card className="rounded-2xl shadow-sm">
              <div className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-xl font-semibold text-foreground">{vendorName}</div>
                    <div className="mt-1 text-sm text-muted-foreground">
                      {exp.expenseNumber} • {formatMMDDYYYY(exp.expenseDate)}
                      {exp.dueDate ? ` • Due ${formatMMDDYYYY(exp.dueDate)}` : ''}
                      {exp.attachmentUrl ? ' • 📎' : ''}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-xl font-semibold text-foreground">{formatMoneyK(toNumber(exp.amount))}</div>
                    <div className={`text-sm ${st.cls}`}>{st.text}</div>
                  </div>
                </div>

                {canEdit ? (
                  <Button className="mt-4 w-full" type="button" onClick={() => navigate(`/expenses/${expenseId}/edit`)}>
                    Edit Draft
                  </Button>
                ) : null}
              </div>
            </Card>

            <Card className="rounded-2xl shadow-sm">
              <div className="p-4">
                <div className="text-sm font-medium text-foreground">Details</div>
                <div className="mt-2 space-y-2 text-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div className="text-muted-foreground">Description</div>
                    <div className="text-right text-foreground whitespace-pre-wrap">{String(exp.description ?? '') || '—'}</div>
                  </div>
                  <div className="flex items-start justify-between gap-3">
                    <div className="text-muted-foreground">Currency</div>
                    <div className="text-right text-foreground">{exp.currency ? String(exp.currency) : '—'}</div>
                  </div>
                  <div className="flex items-start justify-between gap-3">
                    <div className="text-muted-foreground">Category</div>
                    <div className="text-right text-foreground">
                      {exp.expenseAccount ? `${exp.expenseAccount.code} - ${exp.expenseAccount.name}` : '—'}
                    </div>
                  </div>
                </div>
              </div>
            </Card>

            <Card className="rounded-2xl shadow-sm">
              <div className="p-4">
                <div className="text-sm font-medium text-foreground">Attachment</div>
                {exp.attachmentUrl ? (
                  <a
                    href={exp.attachmentUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-3 block overflow-hidden rounded-xl border border-border"
                  >
                    <img src={exp.attachmentUrl} alt="Expense attachment" className="h-56 w-full object-cover" />
                    <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
                      Tap to open
                    </div>
                  </a>
                ) : (
                  <div className="mt-2 text-sm text-muted-foreground">No attachment.</div>
                )}
              </div>
            </Card>

            {Array.isArray(exp.payments) && exp.payments.length > 0 ? (
              <Card className="rounded-2xl shadow-sm">
                <div className="p-4">
                  <div className="text-sm font-medium text-foreground">Payments</div>
                  <div className="mt-2 divide-y divide-border rounded-xl border border-border overflow-hidden">
                    {exp.payments.map((p) => {
                      const reversed = Boolean(p.reversedAt);
                      const bank = p.bankAccount?.name ? String(p.bankAccount.name) : 'Bank';
                      return (
                        <div key={p.id} className="flex items-start justify-between gap-3 px-3 py-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm text-foreground">{bank}</div>
                            <div className="text-xs text-muted-foreground">{formatMMDDYYYY(p.paymentDate)}</div>
                            {reversed ? (
                              <div className="mt-1 text-xs text-rose-600">Reversed</div>
                            ) : null}
                          </div>
                          <div className="shrink-0 text-right text-sm font-medium text-foreground">
                            {formatMoneyK(toNumber(p.amount))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </Card>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}


