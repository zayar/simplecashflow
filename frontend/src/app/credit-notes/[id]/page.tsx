'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useAuth } from '@/contexts/auth-context';
import { fetchApi } from '@/lib/api';
import { formatDateInTimeZone } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ArrowLeft, Loader2, Pencil } from 'lucide-react';

function formatMoney(n: any) {
  const num = Number(n ?? 0);
  if (Number.isNaN(num)) return String(n ?? '');
  return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function CreditNoteDetailPage() {
  const { user, companySettings } = useAuth();
  const params = useParams();
  const id = params.id;
  const tz = companySettings?.timeZone ?? 'Asia/Yangon';

  const [cn, setCn] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [posting, setPosting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    if (!user?.companyId || !id) return;
    setLoading(true);
    try {
      const data = await fetchApi(`/companies/${user.companyId}/credit-notes/${id}`);
      setCn(data);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.companyId, id]);

  async function post() {
    if (!user?.companyId || !id) return;
    setError(null);
    setPosting(true);
    try {
      await fetchApi(`/companies/${user.companyId}/credit-notes/${id}/post`, { method: 'POST', body: JSON.stringify({}) });
      await refresh();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setPosting(false);
    }
  }

  async function deleteDraft() {
    if (!user?.companyId || !id) return;
    if (deleting) return;
    if (!confirm('Delete this credit note? This is only allowed for DRAFT/APPROVED credit notes.')) return;
    setError(null);
    setDeleting(true);
    try {
      await fetchApi(`/companies/${user.companyId}/credit-notes/${id}`, { method: 'DELETE' });
      // back to list
      if (typeof window !== 'undefined') window.location.assign('/credit-notes');
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setDeleting(false);
    }
  }

  const missingAccountLines = useMemo(() => {
    const lines = (cn?.lines ?? []) as any[];
    const missing: number[] = [];
    for (const [idx, l] of lines.entries()) {
      if (!l.incomeAccountId) missing.push(idx + 1);
    }
    return missing;
  }, [cn]);

  const canPost = useMemo(() => cn?.status === 'DRAFT' && missingAccountLines.length === 0, [cn, missingAccountLines]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Link href="/credit-notes">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Credit Note</h1>
            <p className="text-sm text-muted-foreground">Loading…</p>
          </div>
        </div>
        <Card className="shadow-sm">
          <CardContent className="pt-6 space-y-3">
            <Skeleton className="h-7 w-72" />
            <Skeleton className="h-64 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!cn) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Link href="/credit-notes">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Credit Note</h1>
            <p className="text-sm text-muted-foreground">Not found</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/credit-notes">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">{cn.creditNoteNumber}</h1>
            <p className="text-sm text-muted-foreground">{formatDateInTimeZone(cn.creditNoteDate, tz)}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={cn.status === 'POSTED' ? 'secondary' : 'outline'}>{cn.status}</Badge>
          {(cn.status === 'DRAFT' || cn.status === 'APPROVED') ? (
            <>
              {cn.status === 'DRAFT' ? (
                <Link href={`/credit-notes/${cn.id}/edit`}>
                  <Button variant="outline" className="gap-2">
                    <Pencil className="h-4 w-4" /> Edit
                  </Button>
                </Link>
              ) : null}
              {cn.status === 'DRAFT' ? (
                <Button
                  onClick={post}
                  disabled={posting || !canPost}
                  title={!canPost ? 'Set an income account for all lines before posting.' : undefined}
                >
                  {posting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Post Credit Note
                </Button>
              ) : null}
              {!cn.journalEntryId ? (
                <Button variant="destructive" onClick={deleteDraft} disabled={deleting || posting}>
                  {deleting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  {deleting ? 'Deleting…' : 'Delete'}
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
      </div>

      {error && <div className="text-sm text-red-600">{error}</div>}
      {cn?.status === 'DRAFT' && missingAccountLines.length > 0 ? (
        <div className="rounded-xl border border-orange-200 bg-orange-50 px-4 py-3 text-sm">
          <div className="font-medium">Account mapping required to post</div>
          <div className="text-muted-foreground">
            Please select an income account for line(s): <b>{missingAccountLines.join(', ')}</b>. You can still keep this as a draft.
          </div>
        </div>
      ) : null}

      <Card className="shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-lg">Summary</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-3">
          <div>
            <div className="text-xs text-muted-foreground">Customer</div>
            <div className="font-medium">{cn.customer?.name ?? '—'}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Total</div>
            <div className="font-semibold tabular-nums">{formatMoney(cn.total)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Subtotal / Tax</div>
            <div className="font-medium tabular-nums">
              {formatMoney(cn.subtotal ?? 0)} / {formatMoney(cn.taxAmount ?? 0)}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Journal Entry</div>
            <div className="font-medium">{cn.journalEntryId ? `JE #${cn.journalEntryId}` : '—'}</div>
          </div>
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">Lines</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead className="text-right w-[120px]">Qty</TableHead>
                  <TableHead className="text-right w-[140px]">Unit price</TableHead>
                  <TableHead className="text-right w-[140px]">Tax</TableHead>
                  <TableHead className="text-right w-[160px]">Line total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(cn.lines ?? []).map((l: any) => (
                  <TableRow key={l.id}>
                    <TableCell>
                      <div className="font-medium">{l.item?.name ?? '—'}</div>
                      <div className="text-xs text-muted-foreground">{l.description ?? ''}</div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(l.quantity)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(l.unitPrice)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(l.taxAmount ?? 0)}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {formatMoney(Number(l.lineTotal ?? 0) + Number(l.taxAmount ?? 0))}
                    </TableCell>
                  </TableRow>
                ))}
                <TableRow className="bg-muted/40">
                  <TableCell colSpan={4} className="text-right font-medium">Total</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">{formatMoney(cn.total)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {(cn.customerNotes || cn.termsAndConditions) ? (
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">Notes &amp; Terms</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {cn.customerNotes ? (
              <div>
                <div className="text-xs text-muted-foreground">Customer Notes</div>
                <div className="whitespace-pre-wrap">{cn.customerNotes}</div>
              </div>
            ) : null}
            {cn.termsAndConditions ? (
              <div>
                <div className="text-xs text-muted-foreground">Terms &amp; Conditions</div>
                <div className="whitespace-pre-wrap">{cn.termsAndConditions}</div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {cn.journalEntry ? (
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">Journal Entry</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Account</TableHead>
                    <TableHead className="text-right w-[160px]">Debit</TableHead>
                    <TableHead className="text-right w-[160px]">Credit</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(cn.journalEntry.lines ?? []).map((jl: any) => (
                    <TableRow key={jl.id}>
                      <TableCell>
                        <div className="font-medium">
                          {jl.account?.code ? `${jl.account.code} ` : ''}
                          {jl.account?.name ?? '—'}
                        </div>
                        <div className="text-xs text-muted-foreground">{jl.account?.type ?? ''}</div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{Number(jl.debit) !== 0 ? formatMoney(jl.debit) : '—'}</TableCell>
                      <TableCell className="text-right tabular-nums">{Number(jl.credit) !== 0 ? formatMoney(jl.credit) : '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}


