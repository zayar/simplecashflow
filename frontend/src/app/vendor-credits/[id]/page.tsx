'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import { useAuth } from '@/contexts/auth-context';
import { getVendorCredit, postVendorCredit, voidVendorCredit } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

function statusBadge(status: string) {
  switch (status) {
    case 'POSTED':
      return <Badge variant="outline">Posted</Badge>;
    case 'DRAFT':
      return <Badge variant="outline">Draft</Badge>;
    case 'VOID':
      return <Badge variant="destructive">Void</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export default function VendorCreditDetailPage() {
  const { user } = useAuth();
  const params = useParams<{ id: string }>();
  const id = Number(params?.id);

  const [vc, setVc] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [posting, setPosting] = useState(false);
  const [voiding, setVoiding] = useState(false);

  async function load() {
    if (!user?.companyId || !id || Number.isNaN(id)) return;
    setLoading(true);
    try {
      const data = await getVendorCredit(user.companyId, id);
      setVc(data);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load().catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.companyId, id]);

  const total = useMemo(() => Number(vc?.total ?? 0), [vc]);
  const remaining = useMemo(() => Number(vc?.remaining ?? 0), [vc]);

  const missingAccountLines = useMemo(() => {
    const lines = (vc?.lines ?? []) as any[];
    const missing: number[] = [];
    for (let idx = 0; idx < lines.length; idx++) {
      const l = lines[idx];
      if (!l?.accountId) missing.push(idx + 1);
    }
    return missing;
  }, [vc]);

  const canPost = useMemo(() => {
    if (!vc) return false;
    if (vc.status !== 'DRAFT') return false;
    return missingAccountLines.length === 0;
  }, [vc, missingAccountLines]);

  async function doPost() {
    if (!user?.companyId) return;
    if (!confirm('Post this vendor credit? This will create an accounting entry.')) return;
    if (posting) return;
    setPosting(true);
    try {
      await postVendorCredit(user.companyId, id);
      await load();
    } catch (err: any) {
      alert(err?.message ?? 'Failed to post vendor credit');
    } finally {
      setPosting(false);
    }
  }

  async function doVoid() {
    if (!user?.companyId) return;
    const reason = prompt('Void reason?') ?? '';
    if (!reason.trim()) return;
    if (voiding) return;
    setVoiding(true);
    try {
      await voidVendorCredit(user.companyId, id, reason.trim());
      await load();
    } catch (err: any) {
      alert(err?.message ?? 'Failed to void vendor credit');
    } finally {
      setVoiding(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <Link href="/vendor-credits">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">{vc?.creditNumber ?? (loading ? 'Loading…' : 'Vendor Credit')}</h1>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              {vc?.status ? statusBadge(vc.status) : null}
              <span>•</span>
              <span>{vc?.vendor?.name ?? '—'}</span>
              <span>•</span>
              <span>{String(vc?.creditDate ?? '').slice(0, 10) || '—'}</span>
            </div>
          </div>
        </div>

        <div className="flex gap-2">
          {vc?.status === 'DRAFT' ? (
            <Button onClick={doPost} loading={posting} loadingText="Posting..." disabled={!canPost || loading}>
              Post
            </Button>
          ) : null}
          {vc?.status === 'POSTED' ? (
            <Button variant="destructive" onClick={doVoid} loading={voiding} loadingText="Voiding...">
              Void
            </Button>
          ) : null}
          {vc?.journalEntryId ? (
            <Link href={`/journal/${vc.journalEntryId}`} className={buttonVariants({ variant: 'outline' })}>
              View Journal Entry
            </Link>
          ) : null}
        </div>
      </div>

      {vc?.status === 'DRAFT' && missingAccountLines.length > 0 ? (
        <div className="rounded-xl border border-orange-200 bg-orange-50 px-4 py-3 text-sm">
          <div className="font-medium">Account mapping required to post</div>
          <div className="text-muted-foreground">
            Please select an account for line(s): <b>{missingAccountLines.join(', ')}</b>.
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="shadow-sm md:col-span-2">
          <CardHeader>
            <CardTitle className="text-lg">Lines</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead className="w-[140px] text-right">Qty</TableHead>
                  <TableHead className="w-[180px] text-right">Unit Cost</TableHead>
                  <TableHead className="w-[160px] text-right">Line Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(vc?.lines ?? []).map((l: any) => (
                  <TableRow key={l.id}>
                    <TableCell className="font-medium">{l.item?.name ?? `Item #${l.itemId}`}</TableCell>
                    <TableCell className="text-muted-foreground">{l.account ? `${l.account.code} - ${l.account.name}` : '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{Number(l.quantity ?? 0).toLocaleString()}</TableCell>
                    <TableCell className="text-right tabular-nums">{Number(l.unitCost ?? 0).toLocaleString()}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{Number(l.lineTotal ?? 0).toLocaleString()}</TableCell>
                  </TableRow>
                ))}
                {(vc?.lines ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                      No lines.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">Summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Total</span>
              <span className="font-semibold tabular-nums">{total.toLocaleString()}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Remaining</span>
              <span className="font-semibold tabular-nums">{remaining.toLocaleString()}</span>
            </div>
            <div className="pt-2 border-t text-xs text-muted-foreground">
              Apply this credit from a Purchase Bill using <b>Apply Credits</b> in the bill.
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">Applications</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[160px]">Date</TableHead>
                <TableHead>Purchase Bill</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(vc?.applications ?? []).map((a: any) => (
                <TableRow key={a.id}>
                  <TableCell className="text-muted-foreground">{String(a.appliedDate ?? '').slice(0, 10)}</TableCell>
                  <TableCell className="font-medium">
                    {a.purchaseBill?.id ? (
                      <Link href={`/purchase-bills/${a.purchaseBill.id}`} className="text-primary hover:underline">
                        {a.purchaseBill.billNumber}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{Number(a.amount ?? 0).toLocaleString()}</TableCell>
                </TableRow>
              ))}
              {(vc?.applications ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="py-10 text-center text-muted-foreground">
                    No credits applied yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}


