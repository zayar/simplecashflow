'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useAuth } from '@/contexts/auth-context';
import { fetchApi, getInvoiceTemplate, type InvoiceTemplate } from '@/lib/api';
import { formatDateInTimeZone } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ArrowLeft, ChevronDown, Pencil } from 'lucide-react';
import { InvoicePaper } from '@/components/invoice/InvoicePaper';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

function statusBadge(status: string) {
  switch (status) {
    case 'PAID':
      return <Badge variant="secondary">Paid</Badge>;
    case 'POSTED':
      return <Badge variant="outline">Posted</Badge>;
    case 'PARTIAL':
      return <Badge variant="outline">Partial</Badge>;
    case 'DRAFT':
      return <Badge variant="outline">Draft</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export default function PurchaseBillDetailPage() {
  const { user, companySettings } = useAuth();
  const params = useParams<{ id: string }>();
  const id = Number(params?.id);
  const tz = companySettings?.timeZone ?? 'Asia/Yangon';
  const companyName = companySettings?.name ?? 'Company';

  const [bill, setBill] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [posting, setPosting] = useState(false);
  const [hasEligibleCredits, setHasEligibleCredits] = useState(false);
  const [template, setTemplate] = useState<InvoiceTemplate | null>(null);

  const makeIdempotencyKey = () => {
    return typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? (crypto as any).randomUUID()
      : `idem_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  };

  async function load() {
    if (!user?.companyId || !id || Number.isNaN(id)) return;
    setLoading(true);
    try {
      const data = await fetchApi(`/companies/${user.companyId}/purchase-bills/${id}`);
      setBill(data);
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
    getInvoiceTemplate(user.companyId)
      .then((t) => setTemplate(t))
      .catch(() => setTemplate(null));
  }, [user?.companyId]);

  // Determine whether to show "Apply credits" based on eligible credits for this bill's vendor.
  useEffect(() => {
    if (!user?.companyId) return;
    const vendorId = Number(bill?.vendor?.id ?? 0) || null;
    const isPostedOrPartial = bill?.status === 'POSTED' || bill?.status === 'PARTIAL';
    const remainingBalance = Number(bill?.remainingBalance ?? 0);
    if (!vendorId || !isPostedOrPartial || remainingBalance <= 0) {
      setHasEligibleCredits(false);
      return;
    }
    let cancelled = false;
    Promise.all([
      fetchApi(`/companies/${user.companyId}/vendor-credits?vendorId=${vendorId}&eligibleOnly=true`).catch(() => []),
      fetchApi(`/companies/${user.companyId}/vendors/${vendorId}/vendor-advances?onlyOpen=1`).catch(() => []),
    ])
      .then(([credits, advances]: any[]) => {
        if (cancelled) return;
        const hasCredits = Array.isArray(credits) && credits.length > 0;
        const hasAdvances = Array.isArray(advances) && advances.length > 0;
        setHasEligibleCredits(hasCredits || hasAdvances);
      })
      .catch(() => {
        if (cancelled) return;
        setHasEligibleCredits(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user?.companyId, bill?.vendor?.id, bill?.status, bill?.remainingBalance]);

  const total = useMemo(() => Number(bill?.total ?? 0), [bill]);
  const totalPaid = useMemo(() => Number(bill?.totalPaid ?? 0), [bill]);
  const remaining = useMemo(() => Number(bill?.remainingBalance ?? 0), [bill]);
  const paidByCash = useMemo(() => {
    return (bill?.payments ?? [])
      .filter((p: any) => !p.reversedAt)
      .reduce((sum: number, p: any) => sum + Number(p.amount ?? 0), 0);
  }, [bill]);
  const paidByCredits = useMemo(() => {
    return (bill?.creditsApplied ?? []).reduce((sum: number, c: any) => sum + Number(c.amount ?? 0), 0);
  }, [bill]);

  const missingAccountLines = useMemo(() => {
    const lines = (bill?.lines ?? []) as any[];
    const missing: number[] = [];
    for (let idx = 0; idx < lines.length; idx++) {
      const l = lines[idx];
      const it = l.item;
      const isTracked = it?.type === 'GOODS' && !!it?.trackInventory;
      // Tracked items should be Inventory Asset (configured); if account is missing, posting will fail.
      if (isTracked && !l.accountId) missing.push(idx + 1);
      // Non-tracked requires an EXPENSE account mapping before posting.
      if (!isTracked && !l.accountId) missing.push(idx + 1);
    }
    return Array.from(new Set(missing));
  }, [bill]);

  const canPost = useMemo(() => {
    if (!bill) return false;
    if (bill.status !== 'DRAFT') return false;
    return missingAccountLines.length === 0;
  }, [bill, missingAccountLines]);

  const canReceivePayment = bill?.status === 'POSTED' || bill?.status === 'PARTIAL';
  const canApplyCredits = canReceivePayment && remaining > 0 && hasEligibleCredits;

  const postBill = async () => {
    if (!user?.companyId) return;
    if (!confirm('Post this purchase bill? This will increase Inventory and Accounts Payable.')) return;
    if (posting) return;
    setPosting(true);
    try {
      await fetchApi(`/companies/${user.companyId}/purchase-bills/${id}/post`, {
        method: 'POST',
        headers: { 'Idempotency-Key': makeIdempotencyKey() },
        body: JSON.stringify({}),
      });
      await load();
    } catch (err: any) {
      alert(err.message || 'Failed to post purchase bill');
    } finally {
      setPosting(false);
    }
  };

  const deleteBill = async () => {
    if (!user?.companyId || !id || Number.isNaN(id)) return;
    if (!confirm('Delete this purchase bill? This is only allowed for DRAFT/APPROVED bills.')) return;
    try {
      await fetchApi(`/companies/${user.companyId}/purchase-bills/${id}`, { method: 'DELETE' });
      if (typeof window !== 'undefined') window.location.assign('/purchase-bills');
    } catch (err: any) {
      alert(err?.message ?? 'Failed to delete purchase bill');
    }
  };

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

      {/* Top actions */}
      <div className="no-print flex items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <Link href="/purchase-bills">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Purchase Bill</h1>
            {loading && !bill ? (
              <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-4 w-28" />
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{bill?.billNumber ?? `PB-${id}`}</span>
                <span>•</span>
                <span>{bill?.vendor?.name ?? '—'}</span>
                <span>•</span>
                {bill?.status ? statusBadge(bill.status) : null}
                {bill?.status === 'PAID' && paidByCredits > 0 ? (
                  <>
                    <span>•</span>
                    <Badge variant="outline">Paid by credits</Badge>
                  </>
                ) : paidByCredits > 0 ? (
                  <>
                    <span>•</span>
                    <Badge variant="outline">Credits applied</Badge>
                  </>
                ) : null}
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="outline" onClick={() => window.print()}>
            Print
          </Button>
          {bill?.status === 'DRAFT' ? (
            <Link href={`/purchase-bills/${id}/edit`} className={buttonVariants({ variant: 'outline' })}>
              <span className="inline-flex items-center gap-2">
                <Pencil className="h-4 w-4" /> Edit
              </span>
            </Link>
          ) : null}
          {bill?.status === 'DRAFT' || bill?.status === 'APPROVED' ? (
            <Button variant="destructive" onClick={deleteBill}>
              Delete
            </Button>
          ) : null}
          {bill?.status === 'DRAFT' ? (
            <Button
              onClick={postBill}
              loading={posting}
              loadingText="Posting..."
              disabled={loading || !canPost}
              title={!canPost ? 'Set an account for all lines before posting.' : undefined}
            >
              Post
            </Button>
          ) : null}
          {canReceivePayment && remaining > 0 ? (
            <Link href={`/purchase-bills/${id}/payment`} className={buttonVariants({ variant: 'default' })}>
              Record payment
            </Link>
          ) : null}
          {canApplyCredits ? (
            <Link href={`/purchase-bills/${id}/apply-credits`} className={buttonVariants({ variant: 'outline' })}>
              Apply credits
            </Link>
          ) : null}
          {bill?.journalEntryId ? (
            <Link
              href={`/journal/${bill.journalEntryId}`}
              className={buttonVariants({ variant: 'outline' })}
            >
              View Journal Entry
            </Link>
          ) : null}

          {bill && bill.status !== 'VOID' ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary" className="gap-2">
                  Actions <ChevronDown className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  disabled={!bill?.vendor?.id}
                  onClick={() => {
                    const vendorId = Number(bill?.vendor?.id ?? 0);
                    if (!vendorId) return;
                    if (typeof window !== 'undefined') {
                      window.location.assign(
                        `/vendor-advances/new?vendorId=${encodeURIComponent(String(vendorId))}&returnTo=${encodeURIComponent(
                          `/purchase-bills/${id}`
                        )}`
                      );
                    }
                  }}
                >
                  Record Vendor Advance (Prepayment)
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={bill.status === 'DRAFT'}
                  onClick={() => {
                    // Create vendor credit (return) from this purchase bill
                    if (typeof window !== 'undefined') {
                      window.location.assign(`/vendor-credits/new?purchaseBillId=${id}`);
                    }
                  }}
                >
                  Create Vendor Credit (Return)
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>

      {/* Warnings / helper banners */}
      {bill?.status === 'DRAFT' && missingAccountLines.length > 0 ? (
        <div className="no-print rounded-xl border border-orange-200 bg-orange-50 px-4 py-3 text-sm">
          <div className="font-medium">Account mapping required to post</div>
          <div className="text-muted-foreground">
            Please select an account for line(s): <b>{missingAccountLines.join(', ')}</b>. You can still keep this as a draft.
          </div>
        </div>
      ) : null}

      {canApplyCredits ? (
        <div className="no-print rounded-lg border bg-background px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm">
              <span className="font-medium">Credits available for this vendor</span>
              <span className="text-muted-foreground"> (credit notes / advances)</span>
            </div>
            <Link href={`/purchase-bills/${id}/apply-credits`} className="text-sm text-primary hover:underline">
              Apply Now
            </Link>
          </div>
        </div>
      ) : null}

      {/* Bill paper preview (uses the same invoice template renderer) */}
      {bill ? (
        <div className="print-area rounded-lg border bg-muted/20 p-4 sm:p-6">
          <div className="print-paper mx-auto max-w-4xl rounded-lg border bg-white shadow-sm">
            <div className="p-0">
              <InvoicePaper
                invoice={{
                  invoiceNumber: bill.billNumber ?? `PB-${bill.id}`,
                  status: bill.status,
                  invoiceDate: bill.billDate,
                  dueDate: bill.dueDate ?? null,
                  currency: bill.currency ?? null,
                  total: bill.total ?? 0,
                  totalPaid: bill.totalPaid ?? 0,
                  remainingBalance: bill.remainingBalance ?? 0,
                  customer: { name: bill.vendor?.name ?? null },
                  location: { name: bill.warehouse?.name ?? bill.location?.name ?? null },
                  warehouse: { name: bill.warehouse?.name ?? null },
                  customerNotes: bill.notes ?? null,
                  termsAndConditions: bill.termsAndConditions ?? null,
                  taxAmount: bill.taxAmount ?? 0,
                  lines: (bill.lines ?? []).map((l: any) => ({
                    id: l.id,
                    quantity: l.quantity,
                    unitPrice: l.unitCost,
                    discountAmount: l.discountAmount ?? 0,
                    description: l.description ?? null,
                    item: l.item ?? null,
                  })),
                  ...(Array.isArray(bill.payments) ? { payments: bill.payments } : {}),
                  ...(Array.isArray(bill.creditsApplied) ? { creditsApplied: bill.creditsApplied } : {}),
                } as any}
                companyName={companyName}
                tz={tz}
                template={template}
                documentTitle="Bill"
                partyLabel="Vendor"
                dateLabel="Bill Date"
                dueDateLabel="Due Date"
                locationLabel="Location"
                rateLabel="Unit cost"
                balanceLabel="Balance Due"
              />
            </div>
          </div>
        </div>
      ) : null}

      <div className="no-print grid gap-4 md:grid-cols-3">
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
                  <TableHead className="w-[160px] text-right">Discount</TableHead>
                  <TableHead className="w-[160px] text-right">Line Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(bill?.lines ?? []).map((l: any) => (
                  <TableRow key={l.id}>
                    <TableCell className="font-medium">{l.item?.name ?? `Item #${l.itemId}`}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {l.account ? `${l.account.code} - ${l.account.name}` : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{Number(l.quantity ?? 0).toLocaleString()}</TableCell>
                    <TableCell className="text-right tabular-nums">{Number(l.unitCost ?? 0).toLocaleString()}</TableCell>
                    <TableCell className="text-right tabular-nums">{Number(l.discountAmount ?? 0).toLocaleString()}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{Number(l.lineTotal ?? 0).toLocaleString()}</TableCell>
                  </TableRow>
                ))}
                {(bill?.lines ?? []).length === 0 && (
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
            <CardTitle className="text-lg">Summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Bill date</span>
              <span className="font-medium">{bill?.billDate ? String(bill.billDate).slice(0, 10) : '—'}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Due date</span>
              <span className="font-medium">{bill?.dueDate ? String(bill.dueDate).slice(0, 10) : '—'}</span>
            </div>
            <div className="flex justify-between gap-4 pt-2">
              <span className="text-muted-foreground">Total</span>
              <span className="font-semibold tabular-nums">{total.toLocaleString()}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Paid</span>
              <span className="font-medium text-green-700 tabular-nums">{totalPaid.toLocaleString()}</span>
            </div>
            {paidByCredits > 0 ? (
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">Paid via credits</span>
                <span className="font-medium tabular-nums">{paidByCredits.toLocaleString()}</span>
              </div>
            ) : null}
            {paidByCash > 0 ? (
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">Paid via cash</span>
                <span className="font-medium tabular-nums">{paidByCash.toLocaleString()}</span>
              </div>
            ) : null}
            <div className="flex justify-between gap-4 pt-2 border-t">
              <span className="font-semibold">Remaining</span>
              <span className={`font-semibold tabular-nums ${remaining > 0 ? 'text-orange-600' : 'text-green-600'}`}>
                {remaining.toLocaleString()}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="no-print shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">Payments</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[160px]">Date</TableHead>
                <TableHead>Pay From</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="w-[160px]">Journal</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(bill?.payments ?? []).map((p: any) => (
                <TableRow key={p.id}>
                  <TableCell className="text-muted-foreground">{formatDateInTimeZone(p.paymentDate, tz)}</TableCell>
                  <TableCell>{p.bankAccount ? `${p.bankAccount.code} - ${p.bankAccount.name}` : '—'}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{Number(p.amount ?? 0).toLocaleString()}</TableCell>
                  <TableCell>
                    {p.journalEntryId ? (
                      <Link className="text-sm text-blue-600 hover:underline" href={`/journal/${p.journalEntryId}`}>
                        View
                      </Link>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {(bill?.payments ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="py-10 text-center text-muted-foreground">
                    No payments yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>

          {(bill?.creditsApplied ?? []).length > 0 ? (
            <div className="mt-6">
              <div className="mb-2 text-sm font-medium">Credits applied</div>
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/40">
                      <TableHead className="w-[160px]">Date</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Reference</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(bill?.creditsApplied ?? []).map((c: any) => (
                      <TableRow key={c.id}>
                        <TableCell className="text-muted-foreground">{String(c.appliedDate ?? '').slice(0, 10)}</TableCell>
                        <TableCell className="font-medium">
                          {c.kind === 'VENDOR_ADVANCE' ? 'Vendor Advance' : 'Vendor Credit'}
                        </TableCell>
                        <TableCell className="font-medium">
                          {c.kind === 'VENDOR_CREDIT' && c.vendorCredit?.id ? (
                            <Link href={`/vendor-credits/${c.vendorCredit.id}`} className="text-primary hover:underline">
                              {c.vendorCredit.creditNumber}
                            </Link>
                          ) : c.kind === 'VENDOR_ADVANCE' && c.vendorAdvance?.id ? (
                            <span>Advance #{c.vendorAdvance.id}</span>
                          ) : (
                            '—'
                          )}
                        </TableCell>
                        <TableCell className="text-right font-medium tabular-nums">{Number(c.amount ?? 0).toLocaleString()}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}


