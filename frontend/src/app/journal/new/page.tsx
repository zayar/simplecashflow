'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/auth-context';
import { fetchApi } from '@/lib/api';
import { todayInTimeZone } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SelectNative } from '@/components/ui/select-native';
import { Plus, Trash2, ArrowLeft, Loader2 } from 'lucide-react';

type Account = { id: number; code: string; name: string; type: string };
type Line = { accountId: string; debit: string; credit: string };

function fmt(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function NewJournalEntryPage() {
  const { user, companySettings } = useAuth();
  const router = useRouter();
  const tz = companySettings?.timeZone ?? 'Asia/Yangon';

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [date, setDate] = useState('');
  const [description, setDescription] = useState('');
  const [lines, setLines] = useState<Line[]>([
    { accountId: '', debit: '', credit: '' },
    { accountId: '', debit: '', credit: '' },
  ]);

  useEffect(() => {
    if (!date) setDate(todayInTimeZone(tz));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tz]);

  useEffect(() => {
    if (!user?.companyId) return;
    fetchApi(`/companies/${user.companyId}/accounts`)
      .then((rows: any[]) =>
        setAccounts(
          (rows ?? []).map((a) => ({ id: a.id, code: a.code, name: a.name, type: a.type }))
        )
      )
      .catch((e) => setError(e?.message ?? String(e)));
  }, [user?.companyId]);

  const totals = useMemo(() => {
    const sum = (k: 'debit' | 'credit') =>
      lines.reduce((acc, l) => acc + (Number(l[k] || 0) || 0), 0);
    const debit = sum('debit');
    const credit = sum('credit');
    return { debit, credit, balanced: Math.abs(debit - credit) < 0.00001 };
  }, [lines]);

  function updateLine(idx: number, patch: Partial<Line>) {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  function addLine() {
    setLines((prev) => [...prev, { accountId: '', debit: '', credit: '' }]);
  }

  function removeLine(idx: number) {
    setLines((prev) => (prev.length <= 2 ? prev : prev.filter((_, i) => i !== idx)));
  }

  async function submit() {
    if (!user?.companyId) return;
    setError(null);

    const normalizedLines = lines
      .map((l) => ({
        accountId: Number(l.accountId),
        debit: Number(l.debit || 0),
        credit: Number(l.credit || 0),
      }))
      .filter((l) => l.accountId && (l.debit > 0 || l.credit > 0));

    if (normalizedLines.length < 2) {
      setError('Please enter at least 2 non-zero lines.');
      return;
    }
    const debit = normalizedLines.reduce((s, l) => s + l.debit, 0);
    const credit = normalizedLines.reduce((s, l) => s + l.credit, 0);
    if (Math.abs(debit - credit) > 0.00001) {
      setError('Debits and credits must be equal.');
      return;
    }

    setLoading(true);
    try {
      const res = await fetchApi(`/companies/${user.companyId}/journal-entries`, {
        method: 'POST',
        body: JSON.stringify({
          date,
          description,
          lines: normalizedLines,
        }),
      });
      router.push(`/journal/${res.id}`);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/journal">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">New Journal Entry</h1>
          <p className="text-sm text-muted-foreground">Create a balanced journal entry (manual).</p>
        </div>
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">Header</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="date">Date</Label>
            <Input id="date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="desc">Description</Label>
            <Input id="desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Opening adjustment" />
          </div>
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-lg">Lines</CardTitle>
          <Button variant="secondary" onClick={addLine} className="gap-2">
            <Plus className="h-4 w-4" /> Add line
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {lines.map((l, idx) => (
            <div key={idx} className="grid gap-3 md:grid-cols-12 items-end">
              <div className="md:col-span-6">
                <Label>Account</Label>
                <SelectNative
                  value={l.accountId}
                  onChange={(e) => updateLine(idx, { accountId: e.target.value })}
                >
                  <option value="">Select an account…</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={String(a.id)}>
                      {a.code} — {a.name} ({a.type})
                    </option>
                  ))}
                </SelectNative>
              </div>
              <div className="md:col-span-2">
                <Label>Debit</Label>
                <Input
                  inputMode="decimal"
                  value={l.debit}
                  onChange={(e) => updateLine(idx, { debit: e.target.value, credit: e.target.value ? '' : l.credit })}
                  placeholder="0.00"
                />
              </div>
              <div className="md:col-span-2">
                <Label>Credit</Label>
                <Input
                  inputMode="decimal"
                  value={l.credit}
                  onChange={(e) => updateLine(idx, { credit: e.target.value, debit: e.target.value ? '' : l.debit })}
                  placeholder="0.00"
                />
              </div>
              <div className="md:col-span-2 flex justify-end">
                <Button variant="ghost" size="icon" onClick={() => removeLine(idx)} disabled={lines.length <= 2}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}

          <div className="rounded-lg border p-4 flex justify-between">
            <div className="text-sm text-muted-foreground">
              {totals.balanced ? 'Balanced' : 'Not balanced'}
            </div>
            <div className="text-sm tabular-nums">
              <div>Debit: <span className="font-semibold">{fmt(totals.debit)}</span></div>
              <div>Credit: <span className="font-semibold">{fmt(totals.credit)}</span></div>
            </div>
          </div>

          {error && <div className="text-sm text-red-600">{error}</div>}

          <div className="flex justify-end gap-2">
            <Link href="/journal">
              <Button variant="ghost">Cancel</Button>
            </Link>
            <Button onClick={submit} disabled={loading}>
              {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Save & Publish
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}


