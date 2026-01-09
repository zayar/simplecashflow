"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { ArrowLeft, Trash2, Upload } from "lucide-react"

import { useAuth } from "@/contexts/auth-context"
import {
  deletePaymentQrCode,
  getPaymentQrCodes,
  uploadPaymentQrCode,
  type PaymentQrCodes,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

type PaymentMethod = {
  id: "kbz" | "ayaPay" | "uabPay" | "aPlus"
  name: string
  color: string
  bgColor: string
}

const PAYMENT_METHODS: PaymentMethod[] = [
  { id: "kbz", name: "KBZ Pay", color: "#0052CC", bgColor: "#EBF2FF" },
  { id: "ayaPay", name: "AYA Pay", color: "#00843D", bgColor: "#E8F5EC" },
  { id: "uabPay", name: "UAB Pay", color: "#1C4587", bgColor: "#E8EDF5" },
  { id: "aPlus", name: "A+ Wallet", color: "#E91E63", bgColor: "#FCE4EC" },
]

export default function PaymentQrSettingsPage() {
  const { user } = useAuth()
  const companyId = user?.companyId ?? 0

  const [qrCodes, setQrCodes] = useState<PaymentQrCodes>({})
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({})

  useEffect(() => {
    if (!companyId) return
    setLoading(true)
    setError(null)
    getPaymentQrCodes(companyId)
      .then(setQrCodes)
      .catch((e) => setError(e?.message ?? "Failed to load QR codes"))
      .finally(() => setLoading(false))
  }, [companyId])

  const handleFileSelect = async (method: PaymentMethod, file: File) => {
    if (!companyId) return
    setUploading(method.id)
    setError(null)
    try {
      const result = await uploadPaymentQrCode(companyId, method.id, file)
      setQrCodes(result.allQrCodes)
    } catch (e: any) {
      setError(e?.message ?? "Failed to upload QR code")
    } finally {
      setUploading(null)
    }
  }

  const handleDelete = async (method: PaymentMethod) => {
    if (!companyId) return
    if (!confirm(`Remove ${method.name} QR code?`)) return
    setDeleting(method.id)
    setError(null)
    try {
      const result = await deletePaymentQrCode(companyId, method.id)
      setQrCodes(result)
    } catch (e: any) {
      setError(e?.message ?? "Failed to delete QR code")
    } finally {
      setDeleting(null)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/settings">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Payment QR Codes</h1>
          <p className="text-sm text-muted-foreground">
            Upload QR codes for each payment method. Customers will see these when viewing shared invoices.
          </p>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">Loading…</CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {PAYMENT_METHODS.map((method) => {
            const url = qrCodes[method.id]
            const isUploading = uploading === method.id
            const isDeleting = deleting === method.id

            return (
              <Card key={method.id} className="overflow-hidden">
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-3">
                    <div
                      className="flex h-10 w-10 items-center justify-center rounded-lg text-sm font-bold"
                      style={{ backgroundColor: method.bgColor, color: method.color }}
                    >
                      {method.name.split(" ")[0].slice(0, 3).toUpperCase()}
                    </div>
                    <div>
                      <CardTitle className="text-base">{method.name}</CardTitle>
                      <CardDescription className="text-xs">
                        {url ? "QR code uploaded" : "No QR code yet"}
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    ref={(el) => { fileInputRefs.current[method.id] = el }}
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (file) handleFileSelect(method, file)
                      e.target.value = ""
                    }}
                  />

                  {url ? (
                    <div className="space-y-3">
                      <div className="relative aspect-square w-full max-w-[200px] mx-auto overflow-hidden rounded-xl border bg-white shadow-sm">
                        <img
                          src={url}
                          alt={`${method.name} QR`}
                          className="h-full w-full object-contain p-2"
                        />
                      </div>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="flex-1"
                          disabled={isUploading || isDeleting}
                          onClick={() => fileInputRefs.current[method.id]?.click()}
                        >
                          <Upload className="mr-2 h-4 w-4" />
                          {isUploading ? "Uploading…" : "Replace"}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          disabled={isUploading || isDeleting}
                          onClick={() => handleDelete(method)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => fileInputRefs.current[method.id]?.click()}
                      disabled={isUploading}
                      className="w-full flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 p-8 transition-colors hover:border-blue-400 hover:bg-blue-50 disabled:opacity-50"
                    >
                      <Upload className="h-8 w-8 text-slate-400 mb-2" />
                      <span className="text-sm font-medium text-slate-600">
                        {isUploading ? "Uploading…" : "Upload QR Code"}
                      </span>
                      <span className="text-xs text-slate-400 mt-1">PNG or JPG</span>
                    </button>
                  )}
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      <Card className="bg-blue-50 border-blue-200">
        <CardContent className="py-4">
          <div className="flex items-start gap-3">
            <div className="text-2xl">💡</div>
            <div className="text-sm text-blue-800">
              <p className="font-medium mb-1">How this works:</p>
              <ul className="list-disc list-inside space-y-1 text-blue-700">
                <li>Upload your payment QR codes (from KBZ Pay, AYA Pay, etc.)</li>
                <li>Customers will see these QR codes when viewing shared invoices</li>
                <li>They can scan to pay, then upload their payment screenshot as proof</li>
                <li>You&apos;ll review the proof and record the payment manually</li>
              </ul>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

