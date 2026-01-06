import React, { useState, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getPublicInvoice, uploadPublicPaymentProof, deletePublicPaymentProof, PaymentQrCodes } from '../lib/ar';
import { InvoicePaper } from '../components/invoice/InvoicePaper';
import { Card } from '../components/ui/card';

type WalletMethod = 'kbz' | 'aPlus' | 'uabPay' | 'ayaPay';

const WALLET_CONFIG: { key: WalletMethod; label: string; src: string }[] = [
  { key: 'kbz', label: 'KBZ Pay', src: '/kbz-pay.png' },
  { key: 'ayaPay', label: 'AYA Pay', src: '/aya-pay.png' },
  { key: 'uabPay', label: 'UAB Pay', src: '/uab-pay.png' },
  { key: 'aPlus', label: 'A+', src: '/a-plus.png' },
];

function WalletTile({
  label,
  src,
  hasQr,
  onClick,
}: {
  label: string;
  src: string;
  hasQr: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      disabled={!hasQr}
      onClick={onClick}
      className={`flex flex-col items-center justify-center gap-2 rounded-2xl border border-border bg-background px-3 py-3 text-center shadow-sm transition-all ${
        hasQr ? 'hover:border-primary hover:bg-primary/5 active:scale-95' : 'opacity-60'
      }`}
      aria-label={hasQr ? `Pay with ${label}` : `${label} (not configured)`}
    >
      <div className="grid h-14 w-14 place-items-center overflow-hidden rounded-2xl bg-muted">
        <img
          src={src}
          alt={label}
          className="h-12 w-12 object-contain"
          onError={(e) => {
            const el = e.currentTarget;
            el.style.display = 'none';
            const parent = el.parentElement;
            if (parent && !parent.querySelector('[data-fallback]')) {
              const span = document.createElement('span');
              span.setAttribute('data-fallback', '1');
              span.className = 'text-sm font-bold text-foreground';
              span.textContent = label
                .split(/\s+/)
                .slice(0, 2)
                .map((w) => (w ? w[0] : ''))
                .join('')
                .toUpperCase();
              parent.appendChild(span);
            }
          }}
        />
      </div>
      <div className="text-sm font-medium text-foreground">{label}</div>
      {!hasQr && <div className="text-xs text-muted-foreground">Not available</div>}
    </button>
  );
}

export default function PublicInvoice() {
  const params = useParams();
  const token = String(params.token ?? '');
  const queryClient = useQueryClient();

  const [showQrModal, setShowQrModal] = useState(false);
  const [selectedMethod, setSelectedMethod] = useState<WalletMethod | null>(null);
  const [selectedQrUrl, setSelectedQrUrl] = useState<string | null>(null);

  const [uploading, setUploading] = useState(false);
  const [uploadSuccess, setUploadSuccess] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const exportPdf = () => {
    const prev = document.title;
    try {
      document.title = 'Invoice';
      window.print();
    } finally {
      document.title = prev;
    }
  };

  const q = useQuery({
    queryKey: ['public-invoice', token],
    queryFn: async () => await getPublicInvoice(token),
    enabled: token.length > 10,
    retry: false,
  });

  const qrCodes: PaymentQrCodes = q.data?.company?.paymentQrCodes ?? {};
  const invoice = q.data?.invoice;
  const isPaid = invoice?.status === 'PAID';
  const proofs = Array.isArray(invoice?.pendingPaymentProofs) ? invoice?.pendingPaymentProofs : [];

  const handleWalletClick = (method: WalletMethod) => {
    const url = qrCodes[method];
    if (url) {
      setSelectedMethod(method);
      setSelectedQrUrl(url);
      setShowQrModal(true);
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !token) return;

    setUploading(true);
    setUploadSuccess(false);
    try {
      await uploadPublicPaymentProof(token, file);
      setUploadSuccess(true);
      queryClient.invalidateQueries({ queryKey: ['public-invoice', token] });
    } catch (err) {
      console.error('Failed to upload payment proof:', err);
      alert('Failed to upload payment proof. Please try again.');
    } finally {
      setUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleRemoveProof = async (proof: any) => {
    if (!token) return;
    if (!confirm('Remove this payment proof?')) return;
    try {
      const id = typeof proof?.id === 'string' ? proof.id : null;
      const url = typeof proof?.url === 'string' ? proof.url : null;
      await deletePublicPaymentProof(token, id ? { id } : url ? { url } : undefined);
      queryClient.invalidateQueries({ queryKey: ['public-invoice', token] });
    } catch (err) {
      console.error('Failed to remove proof:', err);
      alert('Failed to remove payment proof. Please try again.');
    }
  };

  const handleReplaceAll = async () => {
    if (!token) return;
    if (!confirm('Replace all proofs? This will remove existing images.')) return;
    try {
      await deletePublicPaymentProof(token);
      queryClient.invalidateQueries({ queryKey: ['public-invoice', token] });
      // Open file picker
      document.getElementById('payment-proof-input')?.click();
    } catch (err) {
      console.error('Failed to clear proofs:', err);
      alert('Failed to clear proofs. Please try again.');
    }
  };

  return (
    <div className="min-h-dvh bg-background">
      <div className="mx-auto max-w-xl px-3 py-3">
        <style>{`
          @media print {
            .no-print { display: none !important; }
            body { background: #fff !important; }
          }
        `}</style>

        {q.isLoading ? (
          <Card className="rounded-2xl p-4 text-sm text-muted-foreground shadow-sm">Loading…</Card>
        ) : q.isError ? (
          <Card className="rounded-2xl p-4 text-sm text-destructive shadow-sm">
            {(q.error as any)?.message ? String((q.error as any).message) : 'Link is invalid or expired.'}
          </Card>
        ) : !q.data ? (
          <Card className="rounded-2xl p-4 text-sm text-muted-foreground shadow-sm">Not found.</Card>
        ) : (
          <div className="space-y-3">
            {/* Fully Paid Banner */}
            {isPaid && (
              <div className="no-print rounded-2xl bg-emerald-600 px-4 py-3 text-center">
                <div className="text-lg font-bold text-white">✓ Fully Paid</div>
                <div className="text-sm text-emerald-100">Thank you for your payment!</div>
              </div>
            )}

            <div className="no-print">
              <Card className="rounded-2xl p-3 text-sm text-muted-foreground shadow-sm">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-base font-semibold text-foreground">Invoice</div>
                    <div className="text-xs text-muted-foreground">Export: Print → Save as PDF</div>
                  </div>
                  <button
                    type="button"
                    onClick={exportPdf}
                    className="rounded-xl border border-border bg-background px-3 py-2 text-sm font-medium text-foreground shadow-sm"
                  >
                    Export PDF
                  </button>
                </div>
              </Card>
            </div>

            <Card className="print-paper overflow-hidden rounded-2xl shadow-sm">
              <InvoicePaper
                invoice={{
                  invoiceNumber: q.data.invoice.invoiceNumber,
                  status: q.data.invoice.status,
                  invoiceDate: q.data.invoice.invoiceDate,
                  dueDate: q.data.invoice.dueDate,
                  currency: q.data.invoice.currency,
                  total: q.data.invoice.total,
                  totalPaid: q.data.invoice.totalPaid,
                  remainingBalance: q.data.invoice.remainingBalance,
                  customer: { name: q.data.invoice.customerName ?? null },
                  location: q.data.invoice.locationName ? { name: q.data.invoice.locationName } : null,
                  warehouse: null,
                  customerNotes: q.data.invoice.customerNotes,
                  termsAndConditions: q.data.invoice.termsAndConditions,
                  taxAmount: q.data.invoice.taxAmount,
                  lines: (q.data.invoice.lines ?? []).map((l: any) => ({
                    id: l.id,
                    quantity: l.quantity,
                    unitPrice: l.unitPrice,
                    discountAmount: l.discountAmount,
                    description: l.description,
                    item: l.itemName ? { name: l.itemName } : null,
                  })),
                }}
                companyName={q.data.company.name}
                tz={q.data.company.timeZone}
                template={q.data.company.template}
              />
            </Card>

            {/* Payment Proofs (customer can view; can manage only if not fully paid) */}
            {proofs.length > 0 ? (
              <Card className="no-print overflow-hidden rounded-2xl shadow-sm">
                <div className="px-4 py-3">
                  <div className="text-base font-semibold text-foreground">Payment proofs</div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    {isPaid ? 'Saved for reference.' : 'Saved. You can replace it if needed.'}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 px-4 pb-4">
                  {proofs.map((p: any, idx: number) => (
                    <div key={`${p?.url ?? idx}`} className="overflow-hidden rounded-xl border border-border bg-background">
                      <a href={p.url} target="_blank" rel="noopener noreferrer" className="block">
                        <img src={p.url} alt={`Payment proof ${idx + 1}`} className="h-40 w-full bg-muted object-contain" />
                      </a>
                      {!isPaid ? (
                        <button
                          type="button"
                          onClick={() => handleRemoveProof(p)}
                          className="w-full border-t border-border px-3 py-2 text-sm text-rose-600"
                        >
                          Remove
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>

                {!isPaid ? (
                  <div className="border-t border-border px-4 py-3 flex gap-2">
                    <label
                      htmlFor="payment-proof-input"
                      className={`flex-1 inline-flex cursor-pointer items-center justify-center rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 ${
                        uploading ? 'pointer-events-none opacity-50' : ''
                      }`}
                    >
                      {uploading ? 'Uploading…' : 'Add proof'}
                    </label>
                    <button
                      type="button"
                      onClick={handleReplaceAll}
                      disabled={uploading}
                      className="rounded-xl border border-border bg-background px-4 py-2 text-sm font-medium text-foreground disabled:opacity-50"
                    >
                      Replace all
                    </button>
                  </div>
                ) : null}
              </Card>
            ) : null}

            {/* Pay with wallet - only show if not fully paid */}
            {!isPaid && (
              <Card className="no-print rounded-2xl shadow-sm">
                <div className="px-4 py-3">
                  <div className="text-base font-semibold text-foreground">Pay with wallet</div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    Tap a wallet to scan QR code and pay.
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3 px-4 pb-4">
                  {WALLET_CONFIG.map((w) => (
                    <WalletTile
                      key={w.key}
                      label={w.label}
                      src={w.src}
                      hasQr={!!qrCodes[w.key]}
                      onClick={() => handleWalletClick(w.key)}
                    />
                  ))}
                </div>
              </Card>
            )}

            {/* Payment Proof Upload - only show if not fully paid */}
            {!isPaid && (
              <Card className="no-print rounded-2xl shadow-sm">
                <div className="px-4 py-3">
                  <div className="text-base font-semibold text-foreground">Upload Payment Proof</div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    After making payment, upload a screenshot or receipt for verification.
                  </div>
                </div>
                <div className="px-4 pb-4">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleFileSelect}
                    className="hidden"
                    id="payment-proof-input"
                  />
                  <label
                    htmlFor="payment-proof-input"
                    className={`flex cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border px-4 py-6 text-center transition-colors hover:border-primary hover:bg-primary/5 ${
                      uploading ? 'pointer-events-none opacity-50' : ''
                    }`}
                  >
                    {uploading ? (
                      <span className="text-sm text-muted-foreground">Uploading...</span>
                    ) : (
                      <>
                        <svg className="h-6 w-6 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                        <span className="text-sm font-medium text-foreground">
                          Tap to upload payment proof
                        </span>
                      </>
                    )}
                  </label>
                  {uploadSuccess && (
                    <div className="mt-3 rounded-lg bg-emerald-500/10 px-3 py-2 text-center text-sm text-emerald-400">
                      ✓ Payment proof uploaded successfully!
                    </div>
                  )}
                </div>
              </Card>
            )}
          </div>
        )}
      </div>

      {/* QR Code Modal */}
      {showQrModal && selectedQrUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setShowQrModal(false)}
        >
          <div
            className="w-full max-w-sm overflow-hidden rounded-2xl bg-background shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-border px-4 py-3">
              <div className="flex items-center justify-between">
                <div className="text-lg font-semibold text-foreground">
                  {WALLET_CONFIG.find((w) => w.key === selectedMethod)?.label ?? 'QR Code'}
                </div>
                <button
                  type="button"
                  onClick={() => setShowQrModal(false)}
                  className="rounded-lg p-2 text-muted-foreground hover:bg-muted"
                >
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="text-sm text-muted-foreground">Scan this QR code to pay</div>
            </div>
            <div className="flex items-center justify-center p-6">
              <img
                src={selectedQrUrl}
                alt="Payment QR Code"
                className="max-h-72 max-w-full rounded-lg object-contain"
              />
            </div>
            <div className="border-t border-border px-4 py-3 text-center text-sm text-muted-foreground">
              After payment, upload your receipt above
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
