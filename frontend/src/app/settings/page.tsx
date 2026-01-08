"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { ArrowLeft } from "lucide-react"

import { useAuth } from "@/contexts/auth-context"
import { fetchApi } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { SelectNative } from "@/components/ui/select-native"

type CompanySettings = {
  companyId: number
  name: string
  baseCurrency: string | null
  timeZone: string | null
  fiscalYearStartMonth: number
  baseCurrencyLocked: boolean
}

const TIME_ZONES = [
  { value: "Asia/Yangon", label: "(GMT+6:30) Myanmar Time (Asia/Yangon)" },
  { value: "Asia/Bangkok", label: "(GMT+7) Bangkok (Asia/Bangkok)" },
  { value: "Asia/Singapore", label: "(GMT+8) Singapore (Asia/Singapore)" },
  { value: "UTC", label: "UTC" },
]

const MONTHS = [
  { value: 1, label: "January" },
  { value: 2, label: "February" },
  { value: 3, label: "March" },
  { value: 4, label: "April" },
  { value: 5, label: "May" },
  { value: 6, label: "June" },
  { value: 7, label: "July" },
  { value: 8, label: "August" },
  { value: 9, label: "September" },
  { value: 10, label: "October" },
  { value: 11, label: "November" },
  { value: 12, label: "December" },
]

export default function SettingsPage() {
  const { user, refreshCompanySettings } = useAuth()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [settings, setSettings] = useState<CompanySettings | null>(null)
  const [meLoading, setMeLoading] = useState(false)
  const [me, setMe] = useState<any | null>(null)

  const [phoneForm, setPhoneForm] = useState({ phone: "", code: "" })
  const [phoneOtpSent, setPhoneOtpSent] = useState(false)
  const [phoneBusy, setPhoneBusy] = useState(false)
  const [phoneError, setPhoneError] = useState<string | null>(null)

  const [form, setForm] = useState({
    baseCurrency: "MMK",
    timeZone: "Asia/Yangon",
    fiscalYearStartMonth: 1,
  })

  useEffect(() => {
    if (!user?.companyId) return
    setLoading(true)
    fetchApi(`/companies/${user.companyId}/settings`)
      .then((s: CompanySettings) => {
        setSettings(s)
        setForm({
          baseCurrency: (s.baseCurrency ?? "MMK").toUpperCase(),
          timeZone: s.timeZone ?? "Asia/Yangon",
          fiscalYearStartMonth: Number(s.fiscalYearStartMonth ?? 1),
        })
      })
      .finally(() => setLoading(false))
  }, [user?.companyId])

  useEffect(() => {
    if (!user?.companyId) return
    setMeLoading(true)
    fetchApi(`/me`)
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setMeLoading(false))
  }, [user?.companyId])

  const fiscalYearLabel = useMemo(() => {
    const m = form.fiscalYearStartMonth
    const start = MONTHS.find((x) => x.value === m)?.label ?? "January"
    const endMonth = m === 1 ? 12 : m - 1
    const end = MONTHS.find((x) => x.value === endMonth)?.label ?? "December"
    return `${start} – ${end}`
  }, [form.fiscalYearStartMonth])

  const onSave = async () => {
    if (!user?.companyId) return
    setSaving(true)
    try {
      const updated = await fetchApi(`/companies/${user.companyId}/settings`, {
        method: "PUT",
        body: JSON.stringify({
          baseCurrency: form.baseCurrency.trim().toUpperCase(),
          timeZone: form.timeZone,
          fiscalYearStartMonth: Number(form.fiscalYearStartMonth),
        }),
      })
      setSettings(updated)
      // Keep auth context in sync so other pages (e.g. Currencies) immediately unlock.
      await refreshCompanySettings()
      alert("Saved.")
    } catch (err: any) {
      console.error(err)
      alert(err.message || "Failed to save settings")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/">
          <Button variant="ghost" size="icon" aria-label="Back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Company Profile</h1>
          <p className="text-sm text-muted-foreground">
            Set the core reporting options: base currency, fiscal year, and time zone.
          </p>
        </div>
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">Company settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {loading || !settings ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : (
            <>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="grid gap-2">
                  <Label>Base Currency</Label>
                  <Input
                    value={form.baseCurrency}
                    onChange={(e) => setForm({ ...form, baseCurrency: e.target.value })}
                    placeholder="e.g. MMK"
                    // Only lock if baseCurrency is already set. If it's missing/null, allow setting it
                    // even when transactions exist (needed to enable exchange-rate features for legacy companies).
                    disabled={settings.baseCurrencyLocked && !!settings.baseCurrency}
                  />
                  {settings.baseCurrencyLocked && !!settings.baseCurrency ? (
                    <p className="text-xs text-muted-foreground">
                      You can’t change base currency after transactions exist.
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      This is used as the default currency for reporting.
                    </p>
                  )}
                </div>

                <div className="grid gap-2">
                  <Label>Time Zone</Label>
                  <SelectNative
                    value={form.timeZone}
                    onChange={(e) => setForm({ ...form, timeZone: e.target.value })}
                  >
                    {TIME_ZONES.map((tz) => (
                      <option key={tz.value} value={tz.value}>
                        {tz.label}
                      </option>
                    ))}
                  </SelectNative>
                  <p className="text-xs text-muted-foreground">
                    Controls date boundaries for reports and date/time display.
                  </p>
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div className="grid gap-2">
                  <Label>Fiscal Year Start</Label>
                  <SelectNative
                    value={String(form.fiscalYearStartMonth)}
                    onChange={(e) =>
                      setForm({ ...form, fiscalYearStartMonth: Number(e.target.value) })
                    }
                  >
                    {MONTHS.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </SelectNative>
                  <p className="text-xs text-muted-foreground">
                    Fiscal year: <b>{fiscalYearLabel}</b>
                  </p>
                </div>
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <Button onClick={onSave} disabled={saving}>
                  {saving ? "Saving..." : "Save"}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">Login & Security</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-sm text-muted-foreground">
            Link a phone number so you can log in using OTP on both Web and PWA.
          </div>

          {meLoading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : (
            <div className="rounded-lg border bg-muted/20 p-3 text-sm">
              <div>
                <b>Current phone:</b> {me?.phone ? me.phone : "Not set"}
              </div>
              <div>
                <b>Verified:</b> {me?.phoneVerifiedAt ? "Yes" : "No"}
              </div>
            </div>
          )}

          <div className="grid gap-3 md:grid-cols-2">
            <div className="grid gap-2">
              <Label>Phone</Label>
              <Input
                value={phoneForm.phone}
                onChange={(e) => setPhoneForm({ ...phoneForm, phone: e.target.value })}
                placeholder="e.g. 09xxxxxxxxx"
                disabled={phoneOtpSent}
              />
            </div>

            {phoneOtpSent ? (
              <div className="grid gap-2">
                <Label>OTP Code</Label>
                <Input
                  value={phoneForm.code}
                  onChange={(e) => setPhoneForm({ ...phoneForm, code: e.target.value })}
                  placeholder="6-digit code"
                  inputMode="numeric"
                />
              </div>
            ) : null}
          </div>

          {phoneError ? <div className="text-sm text-destructive">{phoneError}</div> : null}

          <div className="flex flex-wrap gap-2">
            {!phoneOtpSent ? (
              <Button
                variant="outline"
                disabled={phoneBusy || !phoneForm.phone.trim()}
                onClick={async () => {
                  setPhoneError(null)
                  setPhoneBusy(true)
                  try {
                    await fetchApi('/me/phone/request-otp', {
                      method: 'POST',
                      body: JSON.stringify({ phone: phoneForm.phone }),
                    })
                    setPhoneOtpSent(true)
                  } catch (e: any) {
                    setPhoneError(e?.message ?? 'Failed to send OTP')
                  } finally {
                    setPhoneBusy(false)
                  }
                }}
              >
                {phoneBusy ? "Sending..." : "Send OTP"}
              </Button>
            ) : (
              <>
                <Button
                  disabled={phoneBusy || !phoneForm.code.trim()}
                  onClick={async () => {
                    setPhoneError(null)
                    setPhoneBusy(true)
                    try {
                      await fetchApi('/me/phone/verify', {
                        method: 'POST',
                        body: JSON.stringify({ phone: phoneForm.phone, code: phoneForm.code }),
                      })
                      const updatedMe = await fetchApi('/me')
                      setMe(updatedMe)
                      setPhoneOtpSent(false)
                      setPhoneForm({ phone: "", code: "" })
                      alert("Phone linked.")
                    } catch (e: any) {
                      setPhoneError(e?.message ?? 'Failed to verify OTP')
                    } finally {
                      setPhoneBusy(false)
                    }
                  }}
                >
                  {phoneBusy ? "Verifying..." : "Verify & Link"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={phoneBusy}
                  onClick={() => {
                    setPhoneOtpSent(false)
                    setPhoneForm({ phone: "", code: "" })
                    setPhoneError(null)
                  }}
                >
                  Cancel
                </Button>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">Documents</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-muted-foreground">
            Customize how invoices look when printed (logo, colors, font, header/footer).
          </div>
          <Link href="/settings/invoice-template">
            <Button variant="outline">Invoice Template</Button>
          </Link>
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">Payment Methods</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-muted-foreground">
            Upload QR codes for KBZ Pay, AYA Pay, UAB Pay, A+ Wallet. Customers can scan these on shared invoices.
          </div>
          <Link href="/settings/payment-qr">
            <Button variant="outline">Payment QR Codes</Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  )
}


