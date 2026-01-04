"use client"

import { useEffect, useState, useRef } from "react"
import { useParams } from "next/navigation"

import { getPublicInvoice, uploadPaymentProof, type PublicInvoiceResponse } from "@/lib/api"
import { InvoicePaper } from "@/components/invoice/InvoicePaper"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"

// Payment methods with their visual styles
// QR code URLs come from company settings (data.company.paymentQrCodes)
const PAYMENT_METHODS = [
  { id: "kbz", apiKey: "kbz", name: "KBZ Pay", initials: "KBZ", color: "#0052CC", bgColor: "#EBF2FF" },
  { id: "ayaPay", apiKey: "ayaPay", name: "AYA Pay", initials: "AYA", color: "#00843D", bgColor: "#E8F5EC" },
  { id: "uabPay", apiKey: "uabPay", name: "UAB Pay", initials: "UAB", color: "#1C4587", bgColor: "#E8EDF5" },
  { id: "aPlus", apiKey: "aPlus", name: "A+ Wallet", initials: "A+", color: "#E91E63", bgColor: "#FCE4EC" },
] as const

export default function PublicInvoicePage() {
  const params = useParams()
  const token = String((params as any)?.token ?? "")

  const [data, setData] = useState<PublicInvoiceResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // QR Popup state
  const [selectedPayment, setSelectedPayment] = useState<(typeof PAYMENT_METHODS)[0] | null>(null)

  // Proof upload state
  const [showUpload, setShowUpload] = useState(false)
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [uploadPreview, setUploadPreview] = useState<string | null>(null)
  const [uploadNote, setUploadNote] = useState("")
  const [uploading, setUploading] = useState(false)
  const [uploadSuccess, setUploadSuccess] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const exportPdf = () => {
    const prev = document.title
    try {
      document.title = "Invoice"
      window.print()
    } finally {
      document.title = prev
    }
  }

  useEffect(() => {
    if (!token) return
    let cancelled = false
    setLoading(true)
    setError(null)
    getPublicInvoice(token)
      .then((res) => {
        if (cancelled) return
        setData(res)
      })
      .catch((e: any) => {
        if (cancelled) return
        setError(e?.message ?? "Link is invalid or expired.")
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [token])

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      setUploadFile(file)
      setUploadPreview(URL.createObjectURL(file))
      setUploadError(null)
    }
  }

  const handleUploadProof = async () => {
    if (!uploadFile || !token) return
    setUploading(true)
    setUploadError(null)
    try {
      await uploadPaymentProof(token, uploadFile, uploadNote || undefined)
      setUploadSuccess(true)
      setUploadFile(null)
      setUploadPreview(null)
      setUploadNote("")
    } catch (err: any) {
      setUploadError(err?.message ?? "Failed to upload")
    } finally {
      setUploading(false)
    }
  }

  // Get QR code URL for a payment method
  const getQrCodeUrl = (apiKey: string): string | null => {
    const qrCodes = data?.company?.paymentQrCodes
    if (!qrCodes) return null
    return (qrCodes as any)[apiKey] ?? null
  }

  // Filter payment methods to only show those with uploaded QR codes
  const availablePaymentMethods = PAYMENT_METHODS.filter((m) => getQrCodeUrl(m.apiKey))

  const handlePaymentMethodClick = (method: (typeof PAYMENT_METHODS)[number]) => {
    setSelectedPayment(method)
  }

  const remainingBalance = data?.invoice ? Number(data.invoice.remainingBalance) : 0
  const isPaid = data?.invoice?.status === "PAID"
  const isVoid = data?.invoice?.status === "VOID"

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="mx-auto max-w-5xl px-4 py-6">
        {/* Print styles: show the paper only */}
        <style jsx global>{`
          @media print {
            .no-print {
              display: none !important;
            }
            body {
              background: #fff !important;
            }
          }
        `}</style>

        {loading ? (
          <Card className="p-6 text-sm text-muted-foreground">Loading…</Card>
        ) : error ? (
          <Card className="p-6 text-sm text-destructive">{error}</Card>
        ) : !data ? (
          <Card className="p-6 text-sm text-muted-foreground">Not found.</Card>
        ) : (
          <div className="space-y-6">
            {/* Invoice Paper */}
            <div className="rounded-lg border bg-muted/20 p-4 sm:p-6">
              <div className="no-print mb-4 flex items-center justify-end">
                <Button variant="outline" onClick={exportPdf}>
                  Export PDF
                </Button>
              </div>
              <div className="mx-auto max-w-4xl rounded-lg border bg-white shadow-sm">
                <InvoicePaper
                  invoice={{
                    invoiceNumber: data.invoice.invoiceNumber,
                    status: data.invoice.status,
                    invoiceDate: data.invoice.invoiceDate,
                    dueDate: data.invoice.dueDate,
                    currency: data.invoice.currency ?? undefined,
                    total: data.invoice.total,
                    totalPaid: data.invoice.totalPaid,
                    remainingBalance: data.invoice.remainingBalance,
                    customer: { name: data.invoice.customerName },
                    location: data.invoice.locationName ? { name: data.invoice.locationName } : null,
                    warehouse: null,
                    customerNotes: data.invoice.customerNotes,
                    termsAndConditions: data.invoice.termsAndConditions,
                    taxAmount: data.invoice.taxAmount,
                    lines: (data.invoice.lines ?? []).map((l) => ({
                      id: l.id,
                      quantity: l.quantity,
                      unitPrice: l.unitPrice,
                      discountAmount: l.discountAmount,
                      description: l.description,
                      item: l.itemName ? { name: l.itemName } : null,
                    })),
                  }}
                  companyName={data.company.name}
                  tz={data.company.timeZone ?? "Asia/Yangon"}
                  template={data.company.template}
                />
              </div>
            </div>

            {/* Payment Section - Only show if not paid/void */}
            {!isPaid && !isVoid && remainingBalance > 0 && (
              <Card className="no-print overflow-hidden">
                <div className="bg-gradient-to-r from-blue-600 to-indigo-600 px-6 py-4">
                  <h2 className="text-lg font-semibold text-white">Make a Payment</h2>
                  <p className="text-sm text-blue-100">
                    Amount Due: <span className="font-bold">{data.invoice.currency ?? "MMK"} {remainingBalance.toLocaleString()}</span>
                  </p>
                </div>

                <div className="p-6">
                  <p className="mb-4 text-sm text-muted-foreground">
                    Click a payment method to view the QR code:
                  </p>

                  {/* Payment Method Grid */}
                  {availablePaymentMethods.length > 0 ? (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
                      {availablePaymentMethods.map((method) => (
                        <button
                          key={method.id}
                          onClick={() => handlePaymentMethodClick(method)}
                          className="group flex flex-col items-center justify-center rounded-xl border-2 border-slate-200 bg-white p-4 transition-all hover:border-blue-400 hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                        >
                          <div 
                            className="flex h-12 w-12 items-center justify-center rounded-lg text-sm font-bold"
                            style={{ backgroundColor: method.bgColor, color: method.color }}
                          >
                            {method.initials}
                          </div>
                          <span className="mt-2 text-xs font-medium text-slate-700 group-hover:text-blue-600">
                            {method.name}
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="mb-6 rounded-xl bg-slate-100 p-4 text-center text-sm text-slate-500">
                      Payment methods not configured. Please contact the merchant for payment details.
                    </div>
                  )}

                  <div className="border-t pt-6">
                    <h3 className="text-sm font-medium text-slate-700 mb-3">Already paid?</h3>
                    <p className="text-sm text-muted-foreground mb-4">
                      Upload your payment screenshot so we can confirm your payment faster.
                    </p>

                    {uploadSuccess ? (
                      <div className="rounded-xl bg-green-50 border border-green-200 p-4 text-center">
                        <div className="text-green-600 text-lg mb-1">✓</div>
                        <p className="text-sm font-medium text-green-800">
                          Payment proof uploaded successfully!
                        </p>
                        <p className="text-xs text-green-600 mt-1">
                          We&apos;ll review and confirm your payment shortly.
                        </p>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="mt-3"
                          onClick={() => {
                            setUploadSuccess(false)
                            setShowUpload(true)
                          }}
                        >
                          Upload another proof
                        </Button>
                      </div>
                    ) : showUpload ? (
                      <div className="space-y-4">
                        <input
                          type="file"
                          ref={fileInputRef}
                          accept="image/*"
                          onChange={handleFileSelect}
                          className="hidden"
                        />

                        {uploadPreview ? (
                          <div className="relative">
                            <img
                              src={uploadPreview}
                              alt="Payment proof preview"
                              className="w-full max-h-64 object-contain rounded-lg border"
                            />
                            <Button
                              variant="ghost"
                              size="sm"
                              className="absolute top-2 right-2 h-8 w-8 p-0 bg-white/80 hover:bg-white"
                              onClick={() => {
                                setUploadFile(null)
                                setUploadPreview(null)
                              }}
                            >
                              ✕
                            </Button>
                          </div>
                        ) : (
                          <button
                            onClick={() => fileInputRef.current?.click()}
                            className="w-full flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 p-8 transition-colors hover:border-blue-400 hover:bg-blue-50"
                          >
                            <div className="text-3xl mb-2">📷</div>
                            <span className="text-sm font-medium text-slate-600">
                              Tap to select screenshot
                            </span>
                          </button>
                        )}

                        <div>
                          <label className="text-xs font-medium text-slate-500 mb-1 block">
                            Note (optional)
                          </label>
                          <input
                            type="text"
                            value={uploadNote}
                            onChange={(e) => setUploadNote(e.target.value)}
                            placeholder="e.g. Paid via KBZ Pay, Ref: 12345"
                            className="w-full rounded-lg border px-3 py-2 text-sm"
                            maxLength={200}
                          />
                        </div>

                        {uploadError && (
                          <p className="text-sm text-red-600">{uploadError}</p>
                        )}

                        <div className="flex gap-3">
                          <Button
                            variant="outline"
                            className="flex-1"
                            onClick={() => {
                              setShowUpload(false)
                              setUploadFile(null)
                              setUploadPreview(null)
                              setUploadNote("")
                            }}
                          >
                            Cancel
                          </Button>
                          <Button
                            className="flex-1"
                            disabled={!uploadFile || uploading}
                            onClick={handleUploadProof}
                          >
                            {uploading ? "Uploading…" : "Submit Proof"}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <Button
                        variant="outline"
                        className="w-full"
                        onClick={() => setShowUpload(true)}
                      >
                        📎 Upload Payment Screenshot
                      </Button>
                    )}
                  </div>
                </div>
              </Card>
            )}

            {/* Paid Status Banner */}
            {isPaid && (
              <Card className="no-print overflow-hidden bg-green-50 border-green-200">
                <div className="p-6 text-center">
                  <div className="text-4xl mb-2">✓</div>
                  <h2 className="text-lg font-semibold text-green-800">Fully Paid</h2>
                  <p className="text-sm text-green-600">Thank you for your payment!</p>
                </div>
              </Card>
            )}
          </div>
        )}

        {/* QR Code Dialog */}
        <Dialog open={!!selectedPayment} onOpenChange={() => setSelectedPayment(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {selectedPayment && (
                  <div 
                    className="flex h-6 w-6 items-center justify-center rounded text-xs font-bold"
                    style={{ backgroundColor: selectedPayment.bgColor, color: selectedPayment.color }}
                  >
                    {selectedPayment.initials}
                  </div>
                )}
                Pay with {selectedPayment?.name}
              </DialogTitle>
              <DialogDescription>
                Scan this QR code with your {selectedPayment?.name} app to make payment.
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col items-center py-6">
              {/* Actual QR Code from company settings */}
              {selectedPayment && getQrCodeUrl(selectedPayment.apiKey) ? (
                <div className="w-64 h-64 bg-white rounded-2xl border shadow-sm p-3">
                  <img
                    src={getQrCodeUrl(selectedPayment.apiKey)!}
                    alt={`${selectedPayment.name} QR Code`}
                    className="w-full h-full object-contain"
                  />
                </div>
              ) : (
                <div className="w-56 h-56 bg-gradient-to-br from-slate-100 to-slate-200 rounded-2xl flex items-center justify-center border-2 border-dashed border-slate-300">
                  <div className="text-center px-4">
                    <div className="text-4xl mb-2">📱</div>
                    <p className="text-xs text-slate-500">
                      QR code not available.
                      <br />
                      <span className="font-medium">Contact merchant for payment details.</span>
                    </p>
                  </div>
                </div>
              )}

              <div className="mt-6 w-full rounded-xl bg-blue-50 p-4 text-center">
                <p className="text-sm font-medium text-blue-800">Amount to Pay</p>
                <p className="text-2xl font-bold text-blue-600">
                  {data?.invoice?.currency ?? "MMK"} {remainingBalance.toLocaleString()}
                </p>
              </div>

              <p className="mt-4 text-xs text-center text-muted-foreground max-w-xs">
                After making payment, close this popup and upload your payment screenshot below for faster confirmation.
              </p>
            </div>

            <div className="flex gap-3">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => setSelectedPayment(null)}
              >
                Close
              </Button>
              <Button
                className="flex-1"
                onClick={() => {
                  setSelectedPayment(null)
                  setShowUpload(true)
                }}
              >
                I&apos;ve Paid → Upload Proof
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  )
}
