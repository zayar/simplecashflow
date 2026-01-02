"use client"

import { useEffect, useState } from "react"
import { useParams } from "next/navigation"

import { getPublicInvoice, type PublicInvoiceResponse } from "@/lib/api"
import { InvoicePaper } from "@/components/invoice/InvoicePaper"
import { Card } from "@/components/ui/card"

export default function PublicInvoicePage() {
  const params = useParams()
  const token = String((params as any)?.token ?? "")

  const [data, setData] = useState<PublicInvoiceResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

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

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-5xl px-4 py-6">
        {loading ? (
          <Card className="p-6 text-sm text-muted-foreground">Loading…</Card>
        ) : error ? (
          <Card className="p-6 text-sm text-destructive">{error}</Card>
        ) : !data ? (
          <Card className="p-6 text-sm text-muted-foreground">Not found.</Card>
        ) : (
          <div className="rounded-lg border bg-muted/20 p-4 sm:p-6">
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
        )}
      </div>
    </div>
  )
}


