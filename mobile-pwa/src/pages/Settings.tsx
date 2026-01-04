import React, { useState, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { TopBar } from '../components/TopBar';
import { Card } from '../components/ui/card';
import { getPaymentQrCodes, uploadPaymentQrCode, deletePaymentQrCode, PaymentQrCodes } from '../lib/ar';

type WalletMethod = 'kbz' | 'ayaPay' | 'uabPay' | 'aPlus';

const WALLET_CONFIG: { key: WalletMethod; label: string; src: string }[] = [
  { key: 'kbz', label: 'KBZ Pay', src: '/kbz-pay.png' },
  { key: 'ayaPay', label: 'AYA Pay', src: '/aya-pay.png' },
  { key: 'uabPay', label: 'UAB Pay', src: '/uab-pay.png' },
  { key: 'aPlus', label: 'A+ Wallet', src: '/a-plus.png' },
];

export default function Settings() {
  const { user } = useAuth();
  const companyId = user?.companyId ?? 0;
  const queryClient = useQueryClient();

  const [uploadingMethod, setUploadingMethod] = useState<WalletMethod | null>(null);
  const [deletingMethod, setDeletingMethod] = useState<WalletMethod | null>(null);
  const fileInputRefs = useRef<Record<WalletMethod, HTMLInputElement | null>>({
    kbz: null,
    aPlus: null,
    uabPay: null,
    ayaPay: null,
  });

  const qrQuery = useQuery({
    queryKey: ['payment-qr-codes', companyId],
    queryFn: async () => await getPaymentQrCodes(companyId),
    enabled: companyId > 0,
  });

  const qrCodes: PaymentQrCodes = qrQuery.data ?? {};

  const handleUpload = async (method: WalletMethod, file: File) => {
    if (!companyId) return;
    setUploadingMethod(method);
    try {
      await uploadPaymentQrCode(companyId, method, file);
      queryClient.invalidateQueries({ queryKey: ['payment-qr-codes', companyId] });
    } catch (err: any) {
      console.error('Failed to upload QR code:', err);
      const msg = err?.message || 'Unknown error';
      alert(`Failed to upload QR code: ${msg}`);
    } finally {
      setUploadingMethod(null);
      const ref = fileInputRefs.current[method];
      if (ref) ref.value = '';
    }
  };

  const handleDelete = async (method: WalletMethod) => {
    if (!companyId) return;
    if (!confirm(`Delete ${WALLET_CONFIG.find((w) => w.key === method)?.label} QR code?`)) return;
    
    setDeletingMethod(method);
    try {
      await deletePaymentQrCode(companyId, method);
      queryClient.invalidateQueries({ queryKey: ['payment-qr-codes', companyId] });
    } catch (err) {
      console.error('Failed to delete QR code:', err);
      alert('Failed to delete QR code. Please try again.');
    } finally {
      setDeletingMethod(null);
    }
  };

  const handleFileChange = (method: WalletMethod, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleUpload(method, file);
    }
  };

  return (
    <div className="min-h-dvh">
      <TopBar title="Settings" />
      <div className="mx-auto max-w-xl px-4 py-4 safe-bottom">
        <Card className="rounded-2xl border border-border shadow-sm">
          <div className="border-b border-border px-4 py-3">
            <div className="text-base font-semibold text-foreground">Payment QR Codes</div>
            <div className="mt-1 text-sm text-muted-foreground">
              Upload QR codes for your payment wallets. Customers will scan these to pay.
            </div>
          </div>

          {qrQuery.isLoading ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">Loading...</div>
          ) : (
            <div className="divide-y divide-border">
              {WALLET_CONFIG.map((wallet) => {
                const qrUrl = qrCodes[wallet.key];
                const isUploading = uploadingMethod === wallet.key;
                const isDeleting = deletingMethod === wallet.key;
                
                return (
                  <div key={wallet.key} className="flex items-center gap-4 px-4 py-4">
                    {/* Wallet Icon */}
                    <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center overflow-hidden rounded-xl bg-muted">
                      <img
                        src={wallet.src}
                        alt={wallet.label}
                        className="h-10 w-10 object-contain"
                        onError={(e) => {
                          const el = e.currentTarget;
                          el.style.display = 'none';
                        }}
                      />
                    </div>

                    {/* Label & Status */}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-foreground">{wallet.label}</div>
                      <div className="text-xs text-muted-foreground">
                        {qrUrl ? 'QR code uploaded' : 'No QR code'}
                      </div>
                    </div>

                    {/* QR Preview or Upload Button */}
                    <div className="flex items-center gap-2">
                      {qrUrl ? (
                        <>
                          <img
                            src={qrUrl}
                            alt={`${wallet.label} QR`}
                            className="h-12 w-12 rounded-lg border border-border object-cover"
                          />
                          <button
                            type="button"
                            onClick={() => handleDelete(wallet.key)}
                            disabled={isDeleting}
                            className="rounded-lg p-2 text-rose-400 hover:bg-rose-500/10 disabled:opacity-50"
                            title="Delete"
                          >
                            {isDeleting ? (
                              <svg className="h-5 w-5 animate-spin" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                              </svg>
                            ) : (
                              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            )}
                          </button>
                        </>
                      ) : (
                        <>
                          <input
                            ref={(el) => { fileInputRefs.current[wallet.key] = el; }}
                            type="file"
                            accept="image/*"
                            onChange={(e) => handleFileChange(wallet.key, e)}
                            className="hidden"
                            id={`qr-upload-${wallet.key}`}
                          />
                          <label
                            htmlFor={`qr-upload-${wallet.key}`}
                            className={`flex cursor-pointer items-center gap-1 rounded-xl bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 ${
                              isUploading ? 'pointer-events-none opacity-50' : ''
                            }`}
                          >
                            {isUploading ? (
                              <>
                                <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                </svg>
                                <span>Uploading</span>
                              </>
                            ) : (
                              <>
                                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                                </svg>
                                <span>Upload</span>
                              </>
                            )}
                          </label>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        <div className="mt-4 text-center text-xs text-muted-foreground">
          QR codes will appear on shared invoice links for customers to scan and pay.
        </div>
      </div>
    </div>
  );
}

