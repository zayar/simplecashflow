"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { ArrowLeft, RefreshCcw, Save } from "lucide-react"

import { useAuth } from "@/contexts/auth-context"
import {
  clearInvoiceTemplate,
  fetchApi,
  getInvoiceTemplate,
  updateInvoiceTemplate,
  type InvoiceTemplate,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { InvoicePaper } from "@/components/invoice/InvoicePaper"

const FONT_OPTIONS = ["Inter", "Arial", "Times New Roman", "Georgia", "Courier New"] as const

function isHexColor(s: string): boolean {
  const v = String(s ?? "").trim()
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)
}

export default function InvoiceTemplatePage() {
  const { user, companySettings } = useAuth()
  const companyName = companySettings?.name ?? "Company"
  const tz = companySettings?.timeZone ?? "Asia/Yangon"

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [template, setTemplate] = useState<InvoiceTemplate | null>(null)
  const [uploading, setUploading] = useState(false)
  const [logoFile, setLogoFile] = useState<File | null>(null)

  const [form, setForm] = useState({
    logoUrl: "",
    accentColor: "#2F81B7",
    tableHeaderBg: "#2F81B7",
    tableHeaderText: "#FFFFFF",
    fontFamily: "Inter",
    headerText: "",
    footerText: "",
  })

  useEffect(() => {
    if (!user?.companyId) return
    let cancelled = false
    setLoading(true)
    getInvoiceTemplate(user.companyId)
      .then((t) => {
        if (cancelled) return
        setTemplate(t)
        setForm({
          logoUrl: t.logoUrl ?? "",
          accentColor: t.accentColor ?? "#2F81B7",
          tableHeaderBg: t.tableHeaderBg ?? t.accentColor ?? "#2F81B7",
          tableHeaderText: t.tableHeaderText ?? "#FFFFFF",
          fontFamily: t.fontFamily ?? "Inter",
          headerText: t.headerText ?? "",
          footerText: t.footerText ?? "",
        })
      })
      .catch((err: any) => {
        console.error(err)
        alert(err?.message || "Failed to load invoice template")
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [user?.companyId])

  const previewTemplate: InvoiceTemplate = useMemo(() => {
    const accent = isHexColor(form.accentColor) ? form.accentColor.toUpperCase() : "#2F81B7"
    const headBg = isHexColor(form.tableHeaderBg) ? form.tableHeaderBg.toUpperCase() : accent
    const headText = isHexColor(form.tableHeaderText) ? form.tableHeaderText.toUpperCase() : "#FFFFFF"
    const font = form.fontFamily?.trim() || "Inter"
    return {
      version: 1,
      logoUrl: form.logoUrl?.trim() ? form.logoUrl.trim() : null,
      accentColor: accent,
      fontFamily: font,
      headerText: form.headerText ?? null,
      footerText: form.footerText ?? null,
      tableHeaderBg: headBg,
      tableHeaderText: headText,
    }
  }, [form])

  const previewInvoice = useMemo(() => {
    const today = new Date()
    const due = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000)
    return {
      invoiceNumber: "INV-0001",
      status: "POSTED",
      invoiceDate: today,
      dueDate: due,
      currency: "MMK",
      total: 562.75,
      totalPaid: 0,
      remainingBalance: 562.75,
      customer: { name: "Rob & Joe Traders" },
      location: { name: "Main" },
      customerNotes: "Thank you for your business.",
      termsAndConditions: "Payment due on receipt.",
      taxAmount: 0,
      lines: [
        { id: 1, quantity: 1, unitPrice: 300, discountAmount: 0, item: { name: "Brochure Design" }, description: "Brochure Design Single Sided Color" },
        { id: 2, quantity: 1, unitPrice: 250, discountAmount: 0, item: { name: "Web Design Packages (Basic)" }, description: "Custom themes for your business." },
        { id: 3, quantity: 1, unitPrice: 80, discountAmount: 0, item: { name: "Print Ad - Basic - Color" }, description: "Print Ad 1/8 size Color" },
      ],
    }
  }, [])

  const onSave = async () => {
    if (!user?.companyId) return
    setSaving(true)
    try {
      const updated = await updateInvoiceTemplate(user.companyId, previewTemplate)
      setTemplate(updated)
      alert("Saved invoice template.")
    } catch (err: any) {
      console.error(err)
      alert(err?.message || "Failed to save invoice template")
    } finally {
      setSaving(false)
    }
  }

  const onReset = async () => {
    if (!user?.companyId) return
    if (!confirm("Reset invoice template to defaults?")) return
    setSaving(true)
    try {
      const updated = await clearInvoiceTemplate(user.companyId)
      setTemplate(updated)
      setForm({
        logoUrl: updated.logoUrl ?? "",
        accentColor: updated.accentColor ?? "#2F81B7",
        tableHeaderBg: updated.tableHeaderBg ?? updated.accentColor ?? "#2F81B7",
        tableHeaderText: updated.tableHeaderText ?? "#FFFFFF",
        fontFamily: updated.fontFamily ?? "Inter",
        headerText: updated.headerText ?? "",
        footerText: updated.footerText ?? "",
      })
      alert("Reset to defaults.")
    } catch (err: any) {
      console.error(err)
      alert(err?.message || "Failed to reset invoice template")
    } finally {
      setSaving(false)
    }
  }

  const onUploadLogo = async () => {
    if (!user?.companyId) return
    if (!logoFile) return alert("Please choose a logo file first.")
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append("file", logoFile)
      const res = await fetchApi(`/companies/${user.companyId}/invoice-template/logo`, {
        method: "POST",
        body: fd,
      })
      const logoUrl = (res as any)?.logoUrl as string | undefined
      const updatedTemplate = (res as any)?.template as InvoiceTemplate | undefined
      if (logoUrl) setForm((prev) => ({ ...prev, logoUrl }))
      if (updatedTemplate) setTemplate(updatedTemplate)
      alert("Logo uploaded and applied. Click Save if you changed other fields.")
    } catch (err: any) {
      console.error(err)
      alert(err?.message || "Failed to upload logo")
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <Link href="/settings">
            <Button variant="ghost" size="icon" aria-label="Back">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Invoice Template</h1>
            <p className="text-sm text-muted-foreground">
              Customize your invoice design (logo, colors, font, header/footer) and it will apply to printing.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={onReset} disabled={saving || loading}>
            <RefreshCcw className="mr-2 h-4 w-4" />
            Reset
          </Button>
          <Button onClick={onSave} disabled={saving || loading}>
            <Save className="mr-2 h-4 w-4" />
            {saving ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[420px_1fr]">
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">Template Settings</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            {loading ? (
              <div className="text-sm text-muted-foreground">Loading…</div>
            ) : (
              <>
                <div className="grid gap-2">
                  <Label>Logo URL</Label>
                  <Input
                    value={form.logoUrl}
                    onChange={(e) => setForm({ ...form, logoUrl: e.target.value })}
                    placeholder="https://…"
                  />
                  <p className="text-xs text-muted-foreground">
                    Tip: you can paste a public image URL, or upload a logo (stored in GCS).
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Input
                      type="file"
                      accept="image/*"
                      onChange={(e) => setLogoFile(e.target.files?.[0] ?? null)}
                    />
                    <Button type="button" variant="outline" onClick={onUploadLogo} disabled={!logoFile || uploading}>
                      {uploading ? "Uploading..." : "Upload logo"}
                    </Button>
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="grid gap-2">
                    <Label>Accent Color</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        value={form.accentColor}
                        onChange={(e) => setForm({ ...form, accentColor: e.target.value })}
                        placeholder="#2F81B7"
                      />
                      <Input
                        type="color"
                        value={isHexColor(form.accentColor) ? form.accentColor : "#2F81B7"}
                        onChange={(e) => setForm({ ...form, accentColor: e.target.value })}
                        className="h-10 w-14 p-1"
                        aria-label="Pick accent color"
                      />
                    </div>
                  </div>

                  <div className="grid gap-2">
                    <Label>Font Family</Label>
                    <select
                      className="h-10 rounded-md border bg-background px-3 text-sm"
                      value={form.fontFamily}
                      onChange={(e) => setForm({ ...form, fontFamily: e.target.value })}
                    >
                      {FONT_OPTIONS.map((f) => (
                        <option key={f} value={f}>
                          {f}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="grid gap-2">
                    <Label>Table Header BG</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        value={form.tableHeaderBg}
                        onChange={(e) => setForm({ ...form, tableHeaderBg: e.target.value })}
                        placeholder="#2F81B7"
                      />
                      <Input
                        type="color"
                        value={isHexColor(form.tableHeaderBg) ? form.tableHeaderBg : "#2F81B7"}
                        onChange={(e) => setForm({ ...form, tableHeaderBg: e.target.value })}
                        className="h-10 w-14 p-1"
                        aria-label="Pick table header background"
                      />
                    </div>
                  </div>

                  <div className="grid gap-2">
                    <Label>Table Header Text</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        value={form.tableHeaderText}
                        onChange={(e) => setForm({ ...form, tableHeaderText: e.target.value })}
                        placeholder="#FFFFFF"
                      />
                      <Input
                        type="color"
                        value={isHexColor(form.tableHeaderText) ? form.tableHeaderText : "#FFFFFF"}
                        onChange={(e) => setForm({ ...form, tableHeaderText: e.target.value })}
                        className="h-10 w-14 p-1"
                        aria-label="Pick table header text color"
                      />
                    </div>
                  </div>
                </div>

                <div className="grid gap-2">
                  <Label>Header Text (optional)</Label>
                  <Textarea
                    value={form.headerText}
                    onChange={(e) => setForm({ ...form, headerText: e.target.value })}
                    placeholder={"Company address, phone, website…\nMultiple lines supported."}
                    className="min-h-[90px]"
                  />
                </div>

                <div className="grid gap-2">
                  <Label>Footer Text (optional)</Label>
                  <Textarea
                    value={form.footerText}
                    onChange={(e) => setForm({ ...form, footerText: e.target.value })}
                    placeholder={"Bank details, thank you note, small print…\nMultiple lines supported."}
                    className="min-h-[90px]"
                  />
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <div className="space-y-3">
          <div className="text-sm font-medium">Preview</div>
          <div className="rounded-lg border bg-muted/20 p-4 sm:p-6">
            <div className="mx-auto max-w-4xl rounded-lg border bg-white shadow-sm">
              <InvoicePaper invoice={previewInvoice as any} companyName={companyName} tz={tz} template={previewTemplate} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            This preview uses sample data. Your real invoices will use the same template when you click Print.
          </p>
          {template ? null : (
            <p className="text-xs text-muted-foreground">
              Note: if you see defaults only, ensure the backend is migrated and running with the new endpoint.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}


