'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, PackagePlus, CheckCircle2, Ban, FileText } from 'lucide-react';

import { useAuth } from '@/contexts/auth-context';
import { fetchApi, getInvoiceTemplate, type InvoiceTemplate } from '@/lib/api';
import { formatDateInTimeZone, todayInTimeZone } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { InvoicePaper } from '@/components/invoice/InvoicePaper';

function statusBadge(status: string) {
  switch (status) {
    case 'APPROVED':
      return <Badge variant="outline">Approved</Badge>;
    case 'CANCELLED':
      return <Badge variant="destructive">Cancelled</Badge>;
    case 'DRAFT':
      return <Badge variant="outline">Draft</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export default function PurchaseOrderDetailPage() {
  const { user, companySettings } = useAuth();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = Number(params?.id);
  const tz = companySettings?.timeZone ?? 'Asia/Yangon';
  const companyName = companySettings?.name ?? 'Company';

  const [po, setPo] = useState<any | null>(null);
  const [summary, setSummary] = useState<any | null>(null);
  const [linkedReceipts, setLinkedReceipts] = useState<any[]>([]);
  const [linkedBills, setLinkedBills] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [receiptDate, setReceiptDate] = useState('');
  const [template, setTemplate] = useState<InvoiceTemplate | null>(null);

  const canApprove = po?.status === 'DRAFT';
  const canCancel = po?.status === 'DRAFT' || po?.status === 'APPROVED';

  async function load() {
    if (!user?.companyId || !id || Number.isNaN(id)) return;
    setLoading(true);
    try {
      const data = await fetchApi(`/companies/${user.companyId}/purchase-orders/${id}`);
      setPo(data);
      const s = await fetchApi(`/companies/${user.companyId}/purchase-orders/${id}/receiving/summary`).catch(() => null);
      setSummary(s);
      const receipts = await fetchApi(`/companies/${user.companyId}/purchase-receipts?purchaseOrderId=${id}`).catch(() => []);
      setLinkedReceipts(Array.isArray(receipts) ? receipts : []);
      const bills = await fetchApi(`/companies/${user.companyId}/purchase-bills?purchaseOrderId=${id}`).catch(() => []);
      setLinkedBills(Array.isArray(bills) ? bills : []);
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
        // best-effort; renderer falls back to defaults
        if (cancelled) return;
        setTemplate(null);
      });
    return () => {
      cancelled = true;
    };
  }, [user?.companyId]);

  useEffect(() => {
    if (!receiptDate) setReceiptDate(todayInTimeZone(tz));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tz]);

  const remainingTotalQty = useMemo(() => {
    const rows = summary?.rows ?? [];
    return rows.reduce((sum: number, r: any) => sum + Number(r.remainingQty ?? 0), 0);
  }, [summary]);

  async function approve() {
    if (!user?.companyId) return;
    if (!confirm('Approve this purchase order?')) return;
    setSaving(true);
    try {
      await fetchApi(`/companies/${user.companyId}/purchase-orders/${id}/approve`, { method: 'POST', body: JSON.stringify({}) });
      await load();
    } catch (err: any) {
      alert(err?.message ?? 'Failed to approve');
    } finally {
      setSaving(false);
    }
  }

  async function cancel() {
    if (!user?.companyId) return;
    if (!confirm('Cancel this purchase order?')) return;
    setSaving(true);
    try {
      await fetchApi(`/companies/${user.companyId}/purchase-orders/${id}/cancel`, { method: 'POST', body: JSON.stringify({}) });
      await load();
    } catch (err: any) {
      alert(err?.message ?? 'Failed to cancel');
    } finally {
      setSaving(false);
    }
  }

  async function createReceipt() {
    if (!user?.companyId) return;
    if (!confirm('Create a DRAFT purchase receipt from remaining quantities?')) return;
    setSaving(true);
    try {
      const r = await fetchApi(`/companies/${user.companyId}/purchase-orders/${id}/receipts`, {
        method: 'POST',
        body: JSON.stringify({ receiptDate: receiptDate || undefined }),
      });
      const rid = Number((r as any)?.id);
      if (rid) router.push(`/purchase-receipts/${rid}`);
      else await load();
    } catch (err: any) {
      alert(err?.message ?? 'Failed to create receipt');
    } finally {
      setSaving(false);
    }
  }

  async function receiveAndBill() {
    if (!user?.companyId) return;
    if (!confirm('Receive remaining quantities now and create a linked draft bill?')) return;
    setSaving(true);
    try {
      const res = await fetchApi(`/companies/${user.companyId}/purchase-orders/${id}/receive-and-bill`, {
        method: 'POST',
        body: JSON.stringify({ receiptDate: receiptDate || undefined, billDate: receiptDate || undefined }),
      });
      const billId = Number((res as any)?.purchaseBillId);
      const receiptId = Number((res as any)?.purchaseReceiptId);
      if (billId) router.push(`/purchase-bills/${billId}`);
      else if (receiptId) router.push(`/purchase-receipts/${receiptId}`);
      else await load();
    } catch (err: any) {
      alert(err?.message ?? 'Failed to receive & bill');
    } finally {
      setSaving(false);
    }
  }

  async function convertToBill() {
    if (!user?.companyId) return;
    if (!confirm('Convert this purchase order into a draft bill? (For services / non-inventory lines)')) return;
    setSaving(true);
    try {
      const bill = await fetchApi(`/companies/${user.companyId}/purchase-orders/${id}/convert-to-bill`, {
        method: 'POST',
        body: JSON.stringify({ billDate: receiptDate || undefined }),
      });
      const billId = Number((bill as any)?.id);
      if (billId) router.push(`/purchase-bills/${billId}`);
      else await load();
    } catch (err: any) {
      alert(err?.message ?? 'Failed to convert to bill');
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
          <Link href="/purchase-orders">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Purchase Order</h1>
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{po?.poNumber ?? `PO-${id}`}</span>
              <span>•</span>
              <span>{po?.vendor?.name ?? po?.vendorName ?? '—'}</span>
              <span>•</span>
              {po?.status ? statusBadge(po.status) : null}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="outline" onClick={() => window.print()}>
            Print
          </Button>
          {canApprove && (
            <Button className="gap-2" onClick={approve} disabled={saving}>
              <CheckCircle2 className="h-4 w-4" />
              Approve
            </Button>
          )}
          {canCancel && (
            <Button variant="outline" className="gap-2" onClick={cancel} disabled={saving}>
              <Ban className="h-4 w-4" />
              Cancel
            </Button>
          )}
        </div>
      </div>

      {/* PO paper preview (same renderer as invoice/bill) */}
      {po ? (
        <div className="print-area rounded-lg border bg-muted/20 p-4 sm:p-6">
          <div className="print-paper mx-auto max-w-4xl rounded-lg border bg-white shadow-sm">
            <div className="p-0">
              <InvoicePaper
                invoice={{
                  invoiceNumber: po.poNumber ?? `PO-${po.id}`,
                  status: po.status,
                  invoiceDate: po.orderDate,
                  dueDate: po.expectedDate ?? null,
                  currency: po.currency ?? null,
                  total: po.total ?? 0,
                  totalPaid: 0,
                  remainingBalance: po.total ?? 0,
                  customer: { name: po.vendor?.name ?? po.vendorName ?? null },
                  location: { name: po.location?.name ?? po.locationName ?? null },
                  customerNotes: po.notes ?? null,
                  termsAndConditions: null,
                  taxAmount: 0,
                  lines: (po.lines ?? []).map((l: any) => ({
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
                documentTitle="Purchase Order"
                partyLabel="Vendor"
                dateLabel="Order Date"
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
            <div className="text-sm text-muted-foreground">Order date</div>
            <div className="font-medium">{po?.orderDate ? formatDateInTimeZone(po.orderDate, tz) : '—'}</div>
          </div>
          <div>
            <div className="text-sm text-muted-foreground">Location</div>
            <div className="font-medium">{po?.location?.name ?? po?.locationName ?? '—'}</div>
          </div>
          <div>
            <div className="text-sm text-muted-foreground">Total</div>
            <div className="font-medium tabular-nums">{Number(po?.total ?? 0).toLocaleString()}</div>
          </div>
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div className="space-y-1">
            <CardTitle className="text-lg">Lines</CardTitle>
            {summary ? (
              <p className="text-sm text-muted-foreground">
                Remaining qty total: <span className="font-medium">{Number(remainingTotalQty).toLocaleString()}</span>
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Receipt date</Label>
              <Input type="date" value={receiptDate} onChange={(e) => setReceiptDate(e.target.value)} className="h-9" />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                className="gap-2"
                onClick={createReceipt}
                disabled={saving || !summary || remainingTotalQty <= 0}
              >
                <PackagePlus className="h-4 w-4" />
                Create Receipt
              </Button>
              <Button
                className="gap-2"
                onClick={receiveAndBill}
                disabled={saving || !summary || remainingTotalQty <= 0}
              >
                <PackagePlus className="h-4 w-4" />
                Receive &amp; Bill
              </Button>
              <Button variant="outline" className="gap-2" onClick={convertToBill} disabled={saving}>
                <FileText className="h-4 w-4" />
                Convert to Bill
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead className="text-right">Ordered</TableHead>
                <TableHead className="text-right">Remaining</TableHead>
                <TableHead className="text-right">Unit cost</TableHead>
                <TableHead className="text-right">Discount</TableHead>
                <TableHead className="text-right">Line total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(po?.lines ?? []).map((l: any) => {
                const remRow = (summary?.rows ?? []).find((r: any) => Number(r.purchaseOrderLineId) === Number(l.id));
                return (
                  <TableRow key={l.id}>
                    <TableCell className="font-medium">{l.item?.name ?? `Item #${l.itemId}`}</TableCell>
                    <TableCell className="text-right tabular-nums">{Number(l.quantity ?? 0).toLocaleString()}</TableCell>
                    <TableCell className="text-right tabular-nums">{Number(remRow?.remainingQty ?? 0).toLocaleString()}</TableCell>
                    <TableCell className="text-right tabular-nums">{Number(l.unitCost ?? 0).toLocaleString()}</TableCell>
                    <TableCell className="text-right tabular-nums">{Number(l.discountAmount ?? 0).toLocaleString()}</TableCell>
                    <TableCell className="text-right tabular-nums">{Number(l.lineTotal ?? 0).toLocaleString()}</TableCell>
                  </TableRow>
                );
              })}
              {!loading && (po?.lines ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
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
          <CardTitle className="text-lg">Linked Documents</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <div className="text-sm font-medium">Purchase Receipts</div>
            {linkedReceipts.length ? (
              <div className="space-y-2">
                {linkedReceipts.map((r: any) => (
                  <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm">
                    <div className="flex items-center gap-2">
                      <Link className="font-medium underline-offset-4 hover:underline" href={`/purchase-receipts/${r.id}`}>
                        {r.receiptNumber ?? `Receipt #${r.id}`}
                      </Link>
                      <span className="text-muted-foreground">{r.status}</span>
                    </div>
                    <div className="text-muted-foreground">
                      {r.receiptDate ? formatDateInTimeZone(r.receiptDate, tz) : '—'} • {Number(r.total ?? 0).toLocaleString()}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">No receipts yet.</div>
            )}
          </div>

          <div className="space-y-2">
            <div className="text-sm font-medium">Purchase Bills</div>
            {linkedBills.length ? (
              <div className="space-y-2">
                {linkedBills.map((b: any) => (
                  <div key={b.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm">
                    <div className="flex items-center gap-2">
                      <Link className="font-medium underline-offset-4 hover:underline" href={`/purchase-bills/${b.id}`}>
                        {b.billNumber ?? `Bill #${b.id}`}
                      </Link>
                      <span className="text-muted-foreground">{b.status}</span>
                    </div>
                    <div className="text-muted-foreground">
                      {b.billDate ? formatDateInTimeZone(b.billDate, tz) : '—'} • {Number(b.total ?? 0).toLocaleString()}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">No bills yet.</div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

