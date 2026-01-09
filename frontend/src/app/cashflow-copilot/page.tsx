"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useAuth } from "@/contexts/auth-context"
import {
  CashflowCopilotForecast,
  CashflowCopilotScenario,
  getCashflowCopilotForecast,
  getCashflowCopilotInsights,
  CashflowCopilotSettings,
  CashflowRecurringItem,
  getCashflowCopilotSettings,
  updateCashflowCopilotSettings,
  listCashflowRecurringItems,
  createCashflowRecurringItem,
  updateCashflowRecurringItem,
  deleteCashflowRecurringItem,
} from "@/lib/api"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { SelectNative } from "@/components/ui/select-native"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ArrowRight, Settings2, Sparkles } from "lucide-react"

function fmtMoney(amount: any): string {
  const n = Number(amount ?? 0)
  if (!Number.isFinite(n)) return String(amount ?? "0")
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 })
}

function severityVariant(s: string): "destructive" | "secondary" | "outline" {
  if (s === "high") return "destructive"
  if (s === "medium") return "secondary"
  return "outline"
}

function DriverLink({ d }: { d: any }) {
  const href =
    d.kind === "invoice"
      ? `/invoices/${d.id}`
      : d.kind === "purchase_bill"
        ? `/purchase-bills/${d.id}`
        : d.kind === "expense"
          ? `/expenses/${d.id}`
          : null
  if (!href) return <span className="text-muted-foreground">{d.label}</span>
  return (
    <Link className="text-primary hover:underline" href={href}>
      {d.label}
    </Link>
  )
}

function EndingCashLine({ series }: { series: CashflowCopilotForecast["series"] }) {
  const points = useMemo(() => {
    const rows = series.map((w, i) => ({ i, y: Number(w.endingCash ?? 0), xLabel: w.weekStart }))
    const max = Math.max(1, ...rows.map((r) => r.y))
    const min = Math.min(0, ...rows.map((r) => r.y))
    return { rows, max, min }
  }, [series])

  const w = 1000
  const h = 160
  const padX = 24
  const padY = 18
  const plotW = w - padX * 2
  const plotH = h - padY * 2
  const n = points.rows.length || 1
  const scaleX = plotW / Math.max(1, n - 1)
  const range = Math.max(1, points.max - points.min)

  const xy = points.rows.map((r) => {
    const x = padX + r.i * scaleX
    const y = padY + (1 - (r.y - points.min) / range) * plotH
    return { x, y }
  })
  const pathD = xy.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ")

  const zeroY =
    points.min < 0 && points.max > 0
      ? padY + (1 - (0 - points.min) / range) * plotH
      : null

  return (
    <div className="h-56 w-full rounded-xl border bg-background/60 p-4">
      <div className="relative h-full">
        <svg className="absolute left-0 top-0 h-[160px] w-full" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
          {zeroY !== null ? (
            <line x1="0" y1={zeroY} x2={w} y2={zeroY} stroke="hsl(var(--destructive))" strokeOpacity="0.35" strokeWidth="1" />
          ) : null}
          <path d={pathD} fill="none" stroke="hsl(var(--primary))" strokeWidth="2.5" strokeOpacity="0.85" />
          {xy.map((p, idx) => (
            <circle key={idx} cx={p.x} cy={p.y} r="4.5" fill="hsl(var(--primary))" fillOpacity="0.9" />
          ))}
        </svg>
        <div className="flex h-full items-end justify-between text-xs text-muted-foreground">
          <div className="tabular-nums">{fmtMoney(points.min)}</div>
          <div className="tabular-nums">{fmtMoney(points.max)}</div>
        </div>
        <div className="mt-3 text-xs text-muted-foreground">
          Ending cash forecast (weekly)
        </div>
      </div>
    </div>
  )
}

export default function CashflowCopilotPage() {
  const { user } = useAuth()
  const [scenario, setScenario] = useState<CashflowCopilotScenario>("base")
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<CashflowCopilotForecast | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [insightsLoading, setInsightsLoading] = useState(false)
  const [insightsError, setInsightsError] = useState<string | null>(null)
  const [insights, setInsights] = useState<any>(null)

  // Settings + recurring items (owner inputs)
  const [settingsLoading, setSettingsLoading] = useState(false)
  const [settings, setSettings] = useState<CashflowCopilotSettings | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsForm, setSettingsForm] = useState({
    defaultArDelayDays: "7",
    defaultApDelayDays: "0",
    minCashBuffer: "0",
  })

  const [recurringLoading, setRecurringLoading] = useState(false)
  const [recurring, setRecurring] = useState<CashflowRecurringItem[]>([])
  const [recurringOpen, setRecurringOpen] = useState(false)
  const [editingRecurringId, setEditingRecurringId] = useState<number | null>(null)
  const [recurringForm, setRecurringForm] = useState({
    direction: "OUTFLOW" as "INFLOW" | "OUTFLOW",
    name: "",
    amount: "",
    currency: "",
    startDate: "",
    endDate: "",
    frequency: "MONTHLY" as "WEEKLY" | "MONTHLY",
    interval: "1",
    isActive: true,
  })

  useEffect(() => {
    if (!user?.companyId) return
    setLoading(true)
    setError(null)
    getCashflowCopilotForecast(user.companyId, { weeks: 13, scenario })
      .then(setData)
      .catch((e: any) => {
        console.error(e)
        setData(null)
        setError(e?.message ?? String(e))
      })
      .finally(() => setLoading(false))
  }, [user?.companyId, scenario])

  useEffect(() => {
    // Reset insights when scenario changes (so we don't show stale guidance).
    setInsights(null)
    setInsightsError(null)
  }, [scenario])

  useEffect(() => {
    if (!user?.companyId) return
    setSettingsLoading(true)
    getCashflowCopilotSettings(user.companyId)
      .then((s) => {
        setSettings(s)
        setSettingsForm({
          defaultArDelayDays: String(s.defaultArDelayDays ?? 7),
          defaultApDelayDays: String(s.defaultApDelayDays ?? 0),
          minCashBuffer: String(s.minCashBuffer ?? "0"),
        })
      })
      .catch((e) => {
        console.error(e)
        setSettings(null)
      })
      .finally(() => setSettingsLoading(false))
  }, [user?.companyId])

  useEffect(() => {
    if (!user?.companyId) return
    setRecurringLoading(true)
    listCashflowRecurringItems(user.companyId)
      .then((rows) => setRecurring(Array.isArray(rows) ? rows : []))
      .catch((e) => {
        console.error(e)
        setRecurring([])
      })
      .finally(() => setRecurringLoading(false))
  }, [user?.companyId])

  if (!user?.companyId) return null

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            Cashflow Copilot
          </h1>
          <div className="text-sm text-muted-foreground">
            A 13-week cash forecast powered by your invoices, bills, banking balances, and recurring items.
          </div>
        </div>

        <div className="flex items-center gap-2">
          <SelectNative value={scenario} onChange={(e) => setScenario(e.target.value as any)} className="w-[200px]">
            <option value="base">Scenario: Base</option>
            <option value="conservative">Scenario: Conservative</option>
            <option value="optimistic">Scenario: Optimistic</option>
          </SelectNative>
          <Button variant="outline" className="gap-2" onClick={() => setSettingsOpen(true)}>
            <Settings2 className="h-4 w-4" />
            Forecast Settings
          </Button>
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Starting cash (today)</CardTitle>
          </CardHeader>
          <CardContent className="text-3xl font-semibold tabular-nums">
            {loading ? "—" : fmtMoney(data?.startingCash)}
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Lowest cash week</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <div className="text-3xl font-semibold tabular-nums">
              {loading ? "—" : fmtMoney(data?.lowestCash?.endingCash ?? data?.startingCash)}
            </div>
            <div className="text-xs text-muted-foreground">
              {loading ? "" : (data?.lowestCash?.weekStart ? `Week of ${data.lowestCash.weekStart}` : "—")}
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Min cash buffer</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <div className="text-3xl font-semibold tabular-nums">
              {loading ? "—" : fmtMoney(data?.minCashBuffer)}
            </div>
            <div className="text-xs text-muted-foreground">Used for buffer alerts</div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="shadow-sm md:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>Forecast</CardTitle>
              <div className="text-sm text-muted-foreground">
                Ending cash by week. Red line shows zero when applicable.
              </div>
            </div>
            <div className="text-xs text-muted-foreground">
              {data?.currency ? `Currency: ${data.currency}` : "Currency: —"}
            </div>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="py-10 text-center text-muted-foreground">Loading…</div>
            ) : data?.series?.length ? (
              <EndingCashLine series={data.series} />
            ) : (
              <div className="py-10 text-center text-muted-foreground">No forecast data yet.</div>
            )}
            {!loading && data?.warnings?.length ? (
              <div className="mt-4 space-y-2">
                {data.warnings.map((w, i) => (
                  <div key={i} className="text-xs text-muted-foreground">
                    • {w}
                  </div>
                ))}
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Alerts</CardTitle>
            <Link href="/banking" className="text-sm text-muted-foreground hover:text-foreground">
              Banking <ArrowRight className="inline h-4 w-4" />
            </Link>
          </CardHeader>
          <CardContent className="space-y-2">
            {loading ? (
              <div className="py-10 text-center text-muted-foreground">Loading…</div>
            ) : (data?.alerts?.length ?? 0) === 0 ? (
              <div className="py-10 text-center text-muted-foreground">No alerts. Looks healthy.</div>
            ) : (
              <div className="space-y-2">
                {data!.alerts.map((a, idx) => (
                  <div key={idx} className="rounded-md border p-2">
                    <div className="flex items-center justify-between gap-2">
                      <Badge variant={severityVariant(a.severity)}>{a.severity.toUpperCase()}</Badge>
                      <div className="text-xs text-muted-foreground">{a.weekStart ?? ""}</div>
                    </div>
                    <div className="mt-2 text-sm">{a.message}</div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Top expected inflows</CardTitle>
            <Link href="/invoices" className="text-sm text-muted-foreground hover:text-foreground">
              Invoices <ArrowRight className="inline h-4 w-4" />
            </Link>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {loading ? (
              <div className="py-10 text-center text-muted-foreground">Loading…</div>
            ) : (data?.topInflows?.length ?? 0) === 0 ? (
              <div className="py-10 text-center text-muted-foreground">No inflows found.</div>
            ) : (
              data!.topInflows.map((d, idx) => (
                <div key={idx} className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-medium">
                      <DriverLink d={d} />
                    </div>
                    <div className="text-xs text-muted-foreground">{d.expectedDate}</div>
                  </div>
                  <div className="tabular-nums font-semibold">{fmtMoney(d.amount)}</div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Top expected outflows</CardTitle>
            <Link href="/purchase-bills" className="text-sm text-muted-foreground hover:text-foreground">
              Bills <ArrowRight className="inline h-4 w-4" />
            </Link>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {loading ? (
              <div className="py-10 text-center text-muted-foreground">Loading…</div>
            ) : (data?.topOutflows?.length ?? 0) === 0 ? (
              <div className="py-10 text-center text-muted-foreground">No outflows found.</div>
            ) : (
              data!.topOutflows.map((d, idx) => (
                <div key={idx} className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-medium">
                      <DriverLink d={d} />
                    </div>
                    <div className="text-xs text-muted-foreground">{d.expectedDate}</div>
                  </div>
                  <div className="tabular-nums font-semibold">{fmtMoney(d.amount)}</div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      {/* Forecast settings dialog */}
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Cashflow Forecast Settings</DialogTitle>
            <DialogDescription>
              These settings affect forecast timing assumptions (safe; no accounting postings).
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="grid gap-2">
              <Label>Default AR delay (days)</Label>
              <Input
                type="number"
                inputMode="numeric"
                min="0"
                max="180"
                value={settingsForm.defaultArDelayDays}
                onChange={(e) => setSettingsForm((p) => ({ ...p, defaultArDelayDays: e.target.value }))}
              />
              <div className="text-xs text-muted-foreground">Expected days after due date customers pay (avg).</div>
            </div>
            <div className="grid gap-2">
              <Label>Default AP delay (days)</Label>
              <Input
                type="number"
                inputMode="numeric"
                min="0"
                max="180"
                value={settingsForm.defaultApDelayDays}
                onChange={(e) => setSettingsForm((p) => ({ ...p, defaultApDelayDays: e.target.value }))}
              />
              <div className="text-xs text-muted-foreground">Expected days after due date you pay suppliers.</div>
            </div>
            <div className="grid gap-2 md:col-span-2">
              <Label>Minimum cash buffer</Label>
              <Input
                type="number"
                inputMode="numeric"
                step="1"
                value={settingsForm.minCashBuffer}
                onChange={(e) => setSettingsForm((p) => ({ ...p, minCashBuffer: e.target.value }))}
              />
              <div className="text-xs text-muted-foreground">Used for “buffer breach” alerts.</div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setSettingsOpen(false)} disabled={settingsLoading}>
              Cancel
            </Button>
            <Button
              loading={settingsLoading}
              loadingText="Saving..."
              onClick={async () => {
                if (!user?.companyId) return
                setSettingsLoading(true)
                try {
                  const next = await updateCashflowCopilotSettings(user.companyId, {
                    defaultArDelayDays: Number(settingsForm.defaultArDelayDays || 0),
                    defaultApDelayDays: Number(settingsForm.defaultApDelayDays || 0),
                    minCashBuffer: Number(settingsForm.minCashBuffer || 0),
                  })
                  setSettings(next)
                  const f = await getCashflowCopilotForecast(user.companyId, { weeks: 13, scenario })
                  setData(f)
                  setSettingsOpen(false)
                } catch (e: any) {
                  console.error(e)
                  alert(e?.message ?? String(e))
                } finally {
                  setSettingsLoading(false)
                }
              }}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Recurring items */}
      <Card className="shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Recurring items</CardTitle>
            <div className="text-sm text-muted-foreground">
              Add payroll, rent, loan repayments, taxes. This is the biggest way to improve forecast accuracy.
            </div>
          </div>
          <Button
            className="gap-2"
            onClick={() => {
              setEditingRecurringId(null)
              setRecurringForm({
                direction: "OUTFLOW",
                name: "",
                amount: "",
                currency: settings?.minCashBuffer ? "" : "",
                startDate: data?.asOfDate ?? "",
                endDate: "",
                frequency: "MONTHLY",
                interval: "1",
                isActive: true,
              })
              setRecurringOpen(true)
            }}
          >
            + Add
          </Button>
        </CardHeader>
        <CardContent>
          {recurringLoading ? (
            <div className="py-10 text-center text-muted-foreground">Loading…</div>
          ) : recurring.length === 0 ? (
            <div className="py-10 text-center text-muted-foreground">
              No recurring items yet. Add payroll/rent to make the forecast realistic.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="w-[110px]">Type</TableHead>
                  <TableHead className="w-[140px]">Frequency</TableHead>
                  <TableHead className="w-[140px] text-right">Amount</TableHead>
                  <TableHead className="w-[130px]">Start</TableHead>
                  <TableHead className="w-[130px]">End</TableHead>
                  <TableHead className="w-[90px]">Active</TableHead>
                  <TableHead className="w-[160px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recurring.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">{r.name}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{r.direction === "INFLOW" ? "In" : "Out"}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {r.frequency} {r.interval > 1 ? `x${r.interval}` : ""}
                    </TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">{fmtMoney(r.amount)}</TableCell>
                    <TableCell className="text-muted-foreground">{String(r.startDate).slice(0, 10)}</TableCell>
                    <TableCell className="text-muted-foreground">{r.endDate ? String(r.endDate).slice(0, 10) : "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{r.isActive ? "Yes" : "No"}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setEditingRecurringId(r.id)
                            setRecurringForm({
                              direction: r.direction,
                              name: r.name,
                              amount: String(r.amount ?? ""),
                              currency: r.currency ?? "",
                              startDate: String(r.startDate).slice(0, 10),
                              endDate: r.endDate ? String(r.endDate).slice(0, 10) : "",
                              frequency: r.frequency,
                              interval: String(r.interval ?? 1),
                              isActive: !!r.isActive,
                            })
                            setRecurringOpen(true)
                          }}
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={async () => {
                            if (!user?.companyId) return
                            const ok = confirm(`Delete recurring item "${r.name}"?`)
                            if (!ok) return
                            try {
                              await deleteCashflowRecurringItem(user.companyId, r.id)
                              const rows = await listCashflowRecurringItems(user.companyId)
                              setRecurring(Array.isArray(rows) ? rows : [])
                              const f = await getCashflowCopilotForecast(user.companyId, { weeks: 13, scenario })
                              setData(f)
                            } catch (e: any) {
                              console.error(e)
                              alert(e?.message ?? String(e))
                            }
                          }}
                        >
                          Delete
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={recurringOpen} onOpenChange={setRecurringOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingRecurringId ? "Edit recurring item" : "Add recurring item"}</DialogTitle>
            <DialogDescription>Used in your cash forecast. No ledger posting.</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="grid gap-2">
              <Label>Type</Label>
              <SelectNative
                value={recurringForm.direction}
                onChange={(e) => setRecurringForm((p) => ({ ...p, direction: e.target.value as any }))}
              >
                <option value="OUTFLOW">Outflow (pay)</option>
                <option value="INFLOW">Inflow (receive)</option>
              </SelectNative>
            </div>
            <div className="grid gap-2">
              <Label>Frequency</Label>
              <SelectNative
                value={recurringForm.frequency}
                onChange={(e) => setRecurringForm((p) => ({ ...p, frequency: e.target.value as any }))}
              >
                <option value="WEEKLY">Weekly</option>
                <option value="MONTHLY">Monthly</option>
              </SelectNative>
            </div>
            <div className="grid gap-2 md:col-span-2">
              <Label>Name*</Label>
              <Input
                value={recurringForm.name}
                onChange={(e) => setRecurringForm((p) => ({ ...p, name: e.target.value }))}
                placeholder="e.g. Payroll"
              />
            </div>
            <div className="grid gap-2">
              <Label>Amount*</Label>
              <Input
                type="number"
                inputMode="numeric"
                min="0"
                step="1"
                value={recurringForm.amount}
                onChange={(e) => setRecurringForm((p) => ({ ...p, amount: e.target.value }))}
              />
            </div>
            <div className="grid gap-2">
              <Label>Currency (optional)</Label>
              <Input
                value={recurringForm.currency}
                onChange={(e) => setRecurringForm((p) => ({ ...p, currency: e.target.value.toUpperCase() }))}
                placeholder="e.g. MMK"
              />
            </div>
            <div className="grid gap-2">
              <Label>Start date*</Label>
              <Input
                type="date"
                value={recurringForm.startDate}
                onChange={(e) => setRecurringForm((p) => ({ ...p, startDate: e.target.value }))}
              />
            </div>
            <div className="grid gap-2">
              <Label>End date (optional)</Label>
              <Input
                type="date"
                value={recurringForm.endDate}
                onChange={(e) => setRecurringForm((p) => ({ ...p, endDate: e.target.value }))}
              />
            </div>
            <div className="grid gap-2">
              <Label>Interval</Label>
              <Input
                type="number"
                inputMode="numeric"
                min="1"
                max="52"
                value={recurringForm.interval}
                onChange={(e) => setRecurringForm((p) => ({ ...p, interval: e.target.value }))}
              />
              <div className="text-xs text-muted-foreground">
                {recurringForm.frequency === "WEEKLY" ? "Every N weeks" : "Every N months"}
              </div>
            </div>
            <div className="grid gap-2">
              <Label>Status</Label>
              <SelectNative
                value={recurringForm.isActive ? "1" : "0"}
                onChange={(e) => setRecurringForm((p) => ({ ...p, isActive: e.target.value === "1" }))}
              >
                <option value="1">Active</option>
                <option value="0">Inactive</option>
              </SelectNative>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setRecurringOpen(false)} disabled={recurringLoading}>
              Cancel
            </Button>
            <Button
              loading={recurringLoading}
              loadingText="Saving..."
              onClick={async () => {
                if (!user?.companyId) return
                setRecurringLoading(true)
                try {
                  const payload: any = {
                    direction: recurringForm.direction,
                    name: recurringForm.name,
                    amount: Number(recurringForm.amount || 0),
                    currency: recurringForm.currency ? recurringForm.currency : null,
                    startDate: recurringForm.startDate,
                    endDate: recurringForm.endDate ? recurringForm.endDate : null,
                    frequency: recurringForm.frequency,
                    interval: Number(recurringForm.interval || 1),
                    isActive: recurringForm.isActive,
                  }
                  if (editingRecurringId) {
                    await updateCashflowRecurringItem(user.companyId, editingRecurringId, payload)
                  } else {
                    await createCashflowRecurringItem(user.companyId, payload)
                  }
                  const rows = await listCashflowRecurringItems(user.companyId)
                  setRecurring(Array.isArray(rows) ? rows : [])
                  const f = await getCashflowCopilotForecast(user.companyId, { weeks: 13, scenario })
                  setData(f)
                  setRecurringOpen(false)
                } catch (e: any) {
                  console.error(e)
                  alert(e?.message ?? String(e))
                } finally {
                  setRecurringLoading(false)
                }
              }}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card className="shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              Copilot Insights (Beta)
            </CardTitle>
            <div className="text-sm text-muted-foreground">
              Optional AI explanation grounded on your computed forecast.
            </div>
          </div>
          <Button
            variant="secondary"
            disabled={insightsLoading || loading || !data}
            onClick={async () => {
              if (!user?.companyId) return
              setInsightsLoading(true)
              setInsightsError(null)
              try {
                const res = await getCashflowCopilotInsights(user.companyId, { scenario })
                setInsights(res)
              } catch (e: any) {
                console.error(e)
                setInsights(null)
                // If backend returns 501, fetchApi throws the message; show it directly.
                setInsightsError(e?.message ?? String(e))
              } finally {
                setInsightsLoading(false)
              }
            }}
          >
            {insightsLoading ? "Thinking…" : insights ? "Refresh" : "Generate"}
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {insightsError ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {insightsError}
              <div className="mt-1 text-xs text-muted-foreground">
                If this says Vertex AI isn’t configured, set `GCP_PROJECT_ID` and credentials for the backend.
              </div>
            </div>
          ) : null}

          {!insights && !insightsError ? (
            <div className="text-sm text-muted-foreground">
              Click <b>Generate</b> to get a short explanation and next actions.
            </div>
          ) : null}

          {insights?.insights ? (
            <div className="space-y-4">
              <div>
                <div className="text-sm font-semibold">{insights.insights.headline}</div>
                <div className="mt-1 text-sm text-muted-foreground">{insights.insights.summary}</div>
                <div className="mt-2 text-xs text-muted-foreground">
                  Provider: {insights.provider} • Model: {insights.model} • {insights.cached ? "cached" : "fresh"}
                </div>
              </div>

              {Array.isArray(insights.insights.key_risks) && insights.insights.key_risks.length ? (
                <div className="space-y-2">
                  <div className="text-sm font-semibold">Key risks</div>
                  <div className="space-y-2">
                    {insights.insights.key_risks.map((r: any, idx: number) => (
                      <div key={idx} className="rounded-md border p-2">
                        <div className="flex items-center justify-between gap-2">
                          <div className="font-medium">{r.title}</div>
                          <Badge variant={severityVariant(r.severity)}>{String(r.severity).toUpperCase()}</Badge>
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">{r.evidence}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {Array.isArray(insights.insights.recommended_actions) && insights.insights.recommended_actions.length ? (
                <div className="space-y-2">
                  <div className="text-sm font-semibold">Next actions</div>
                  <div className="space-y-2">
                    {insights.insights.recommended_actions.map((a: any, idx: number) => (
                      <div key={idx} className="rounded-md border p-3">
                        <div className="font-medium">{a.title}</div>
                        <div className="mt-1 text-sm text-muted-foreground">{a.why}</div>
                        {a.link?.href ? (
                          <div className="mt-2">
                            <Link className="text-primary hover:underline text-sm" href={a.link.href}>
                              {a.link.label ?? "Open"} <ArrowRight className="inline h-4 w-4" />
                            </Link>
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}

