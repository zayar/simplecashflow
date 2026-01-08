'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, CheckCircle2, Ban } from 'lucide-react';

import { useAuth } from '@/contexts/auth-context';
import { fetchApi, getInvoiceTemplate, type InvoiceTemplate } from '@/lib/api';
import { formatDateInTimeZone } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { InvoicePaper } from '@/components/invoice/InvoicePaper';

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

export default function PurchaseReceiptDetailPage() {
  const { user, companySettings } = useAuth();
  const params = useParams<{ id: string }>();
  const id = Number(params?.id);
  const tz = companySettings?.timeZone ?? 'Asia/Yangon';
  const companyName = companySettings?.name ?? 'Company';

  const [r, setR] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [template, setTemplate] = useState<InvoiceTemplate | null>(null);

  async function load() {
    if (!user?.companyId || !id || Number.isNaN(id)) return;
    setLoading(true);
    try {
      const data = await fetchApi(`/companies/${user.companyId}/purchase-receipts/${id}`);
      setR(data);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load().catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.companyId, id]);

  useEffect(() => {
    if (!user?.companyId) return;
    let cancelled = false;
    getInvoiceTemplate(user.companyId)
      .then((t) => {
        if (cancelled) return;
        setTemplate(t);
      })
      .catch(() => {
        if (cancelled) return;
        setTemplate(null);
      });
    return () => {
      cancelled = true;
    };
  }, [user?.companyId]);

  const canPost = r?.status === 'DRAFT';
  const canVoid = r?.status === 'POSTED';

  const total = useMemo(() => Number(r?.total ?? 0), [r?.total]);

  async function post() {
    if (!user?.companyId) return;
    if (!confirm('Post this purchase receipt? This will increase Inventory and create GRNI.')) return;
    setSaving(true);
    try {
      await fetchApi(`/companies/${user.companyId}/purchase-receipts/${id}/post`, { method: 'POST', body: JSON.stringify({}) });
      await load();
    } catch (err: any) {
      alert(err?.message ?? 'Failed to post receipt');
    } finally {
      setSaving(false);
    }
  }

  async function voidReceipt() {
    if (!user?.companyId) return;
    const reason = prompt('Void reason (required):') ?? '';
    if (!reason.trim()) return;
    setSaving(true);
    try {
      await fetchApi(`/companies/${user.companyId}/purchase-receipts/${id}/void`, {
        method: 'POST',
        body: JSON.stringify({ reason: reason.trim() }),
      });
      await load();
    } catch (err: any) {
      alert(err?.message ?? 'Failed to void receipt');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Print styles: show the paper only */}
      <style jsx global>{`
        @media print {
          body * {
            visibility: hidden !important;
          }
          .print-area,
          .print-area * {
            visibility: visible !important;
          }
          .print-area {
            position: absolute !important;
            left: 0 !important;
            top: 0 !important;
            width: 100% !important;
          }
          .no-print {
            display: none !important;
            visibility: hidden !important;
          }
          .print-paper {
            box-shadow: none !important;
            border: none !important;
          }
          body {
            background: white !important;
          }
        }
      `}</style>

      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <Link href="/purchase-receipts">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Purchase Receipt</h1>
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{r?.receiptNumber ?? `PR-${id}`}</span>
              <span>•</span>
              <span>{r?.vendor?.name ?? r?.vendorName ?? '—'}</span>
              <span>•</span>
              {r?.status ? statusBadge(r.status) : null}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="outline" onClick={() => window.print()}>
            Print
          </Button>
          {r?.journalEntryId ? (
            <Link href={`/journal/${r.journalEntryId}`}>
              <Button variant="outline">View Journal Entry</Button>
            </Link>
          ) : null}
          {canPost && (
            <Button className="gap-2" onClick={post} disabled={saving}>
              <CheckCircle2 className="h-4 w-4" />
              Post
            </Button>
          )}
          {canVoid && (
            <Button variant="outline" className="gap-2" onClick={voidReceipt} disabled={saving}>
              <Ban className="h-4 w-4" />
              Void
            </Button>
          )}
        </div>
      </div>

      {/* Receipt paper preview (same renderer as invoice/bill) */}
      {r ? (
        <div className="print-area rounded-lg border bg-muted/20 p-4 sm:p-6">
          <div className="print-paper mx-auto max-w-4xl rounded-lg border bg-white shadow-sm">
            <div className="p-0">
              <InvoicePaper
                invoice={{
                  invoiceNumber: r.receiptNumber ?? `PR-${r.id}`,
                  status: r.status,
                  invoiceDate: r.receiptDate,
                  dueDate: r.expectedDate ?? null,
                  currency: r.currency ?? null,
                  total: r.total ?? 0,
                  totalPaid: 0,
                  remainingBalance: r.total ?? 0,
                  customer: { name: r.vendor?.name ?? r.vendorName ?? null },
                  location: { name: r.location?.name ?? r.locationName ?? null },
                  customerNotes: null,
                  termsAndConditions: null,
                  taxAmount: 0,
                  lines: (r.lines ?? []).map((l: any) => ({
                    id: l.id,
                    quantity: l.quantity,
                    unitPrice: l.unitCost,
                    discountAmount: l.discountAmount ?? 0,
                    description: l.description ?? null,
                    item: l.item ?? null,
                  })),
                } as any}
                companyName={companyName}
                tz={tz}
                template={template}
                documentTitle="Purchase Receipt"
                partyLabel="Vendor"
                dateLabel="Receipt Date"
                dueDateLabel="Expected Date"
                locationLabel="Location"
                rateLabel="Unit cost"
                balanceLabel="Total"
                settledLabel=""
              />
            </div>
          </div>
        </div>
      ) : null}

      <Card className="shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-lg">Summary</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <div>
            <div className="text-sm text-muted-foreground">Receipt date</div>
            <div className="font-medium">{r?.receiptDate ? formatDateInTimeZone(r.receiptDate, tz) : '—'}</div>
          </div>
          <div>
            <div className="text-sm text-muted-foreground">Location</div>
            <div className="font-medium">{r?.location?.name ?? r?.locationName ?? '—'}</div>
          </div>
          <div>
            <div className="text-sm text-muted-foreground">Total</div>
            <div className="font-medium tabular-nums">{Number(total).toLocaleString()}</div>
          </div>
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-lg">Lines</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Unit cost</TableHead>
                <TableHead className="text-right">Discount</TableHead>
                <TableHead className="text-right">Line total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(r?.lines ?? []).map((l: any) => (
                <TableRow key={l.id}>
                  <TableCell className="font-medium">{l.item?.name ?? `Item #${l.itemId}`}</TableCell>
                  <TableCell className="text-right tabular-nums">{Number(l.quantity ?? 0).toLocaleString()}</TableCell>
                  <TableCell className="text-right tabular-nums">{Number(l.unitCost ?? 0).toLocaleString()}</TableCell>
                  <TableCell className="text-right tabular-nums">{Number(l.discountAmount ?? 0).toLocaleString()}</TableCell>
                  <TableCell className="text-right tabular-nums">{Number(l.lineTotal ?? 0).toLocaleString()}</TableCell>
                </TableRow>
              ))}
              {!loading && (r?.lines ?? []).length === 0 && (
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
    </div>
  );
}

