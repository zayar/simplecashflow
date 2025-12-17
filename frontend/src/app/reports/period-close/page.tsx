'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { closePeriod, PeriodCloseResult } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { formatDateInputInTimeZone, todayInTimeZone } from '@/lib/utils';

export default function PeriodClosePage() {
  const { user, companySettings } = useAuth();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<PeriodCloseResult | null>(null);

  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  useEffect(() => {
    const tz = companySettings?.timeZone ?? 'Asia/Yangon';
    if (from && to) return;
    const today = todayInTimeZone(tz);
    const parts = today.split('-').map((x) => Number(x));
    const y = parts[0];
    const m = parts[1]; // 1-12
    if (!y || !m) return;
    const first = formatDateInputInTimeZone(new Date(Date.UTC(y, m - 1, 1)), tz);
    const last = formatDateInputInTimeZone(new Date(Date.UTC(y, m, 0)), tz);
    if (!from) setFrom(first);
    if (!to) setTo(last);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companySettings?.timeZone]);

  async function runClose() {
    if (!user?.companyId) return;

    const confirmed = confirm(
      `Close period ${from} to ${to}?\n\nThis will create an immutable Closing Journal Entry and move income/expense into Retained Earnings.`
    );
    if (!confirmed) return;

    setLoading(true);
    setResult(null);
    try {
      const res = await closePeriod(user.companyId, from, to);
      setResult(res);
    } catch (err: any) {
      console.error(err);
      alert(err.message || 'Failed to close period');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Close Period</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="from">From</Label>
              <Input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="to">To</Label>
              <Input id="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
          </div>

          <div className="rounded-md bg-slate-50 p-4 text-sm text-slate-700">
            <div className="font-semibold">What happens when you close?</div>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>Creates one immutable Closing Journal Entry dated on the <b>To</b> date.</li>
              <li>Zeros out all INCOME and EXPENSE balances for the period.</li>
              <li>Moves the net profit into <b>Retained Earnings (Equity)</b>.</li>
              <li>Prevents closing the same period twice.</li>
            </ul>
          </div>

          <Button onClick={runClose} disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Close Period
          </Button>
        </CardContent>
      </Card>

      {result && (
        <Card>
          <CardHeader>
            <CardTitle>Result</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div><b>Status:</b> {result.alreadyClosed ? 'Already closed (no new entry created)' : 'Closed successfully'}</div>
            <div><b>Net Profit:</b> {result.netProfit ?? '—'}</div>
            <div><b>Journal Entry:</b> <Link className="text-blue-700 hover:underline" href={`/journal/${result.journalEntryId}`}>JE #{result.journalEntryId}</Link></div>
            <div className="text-xs text-muted-foreground">
              Tip: run Trial Balance / Balance Sheet again to see the effect.
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
