"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useAuth } from "@/contexts/auth-context"
import { fetchApi } from "@/lib/api"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { formatDateInputInTimeZone, todayInTimeZone } from "@/lib/utils"
import { ArrowRight, Plus, Search } from "lucide-react"

function fmtK(amount: any): string {
  const n = Number(amount ?? 0)
  if (!Number.isFinite(n)) return "K 0"
  // "K" dashboard style: show amounts in thousands.
  const k = Math.round(n / 1000)
  return `K ${k.toLocaleString()}`
}

function fmtMoney(amount: any): string {
  const n = Number(amount ?? 0)
  if (!Number.isFinite(n)) return "0"
  return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

function ZeroBaselineBars({
  buckets,
  selectedLabel,
  onSelect,
}: {
  buckets: Array<{ label: string; net: string; inflow?: string; outflow?: string; from?: string; to?: string }>
  selectedLabel: string | null
  onSelect: (label: string) => void
}) {
  const data = buckets.map((b) => ({
    label: b.label,
    inflow: Number(b.inflow ?? (Number(b.net ?? 0) > 0 ? b.net : 0)),
    outflow: Number(b.outflow ?? (Number(b.net ?? 0) < 0 ? Math.abs(Number(b.net ?? 0)) : 0)),
    net: Number(b.net ?? 0),
  }))

  const maxAbs = Math.max(
    1,
    ...data.flatMap((d) => [Math.abs(d.inflow), Math.abs(d.outflow), Math.abs(d.net)])
  )

  const plotH = 160
  const half = plotH / 2
  const pad = 6
  const scale = (half - pad) / maxAbs

  const svgW = 1000
  const step = data.length > 0 ? svgW / data.length : svgW
  const points = data.map((d, i) => {
    const x = i * step + step / 2
    const y = half - d.net * scale
    return { x, y }
  })
  const pathD =
    points.length > 0 ? points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ") : ""

  return (
    <div className="h-56 w-full rounded-xl border bg-background/60 p-4">
      <div className="relative h-full">
        {/* Net line overlay (like the reference image) */}
        <svg
          className="pointer-events-none absolute left-0 top-0 h-[160px] w-full"
          viewBox={`0 0 ${svgW} ${plotH}`}
          preserveAspectRatio="none"
        >
          <line x1="0" y1={half} x2={svgW} y2={half} stroke="hsl(var(--muted))" strokeWidth="1" />
          {pathD ? <path d={pathD} fill="none" stroke="hsl(var(--foreground))" strokeWidth="2" strokeOpacity="0.8" /> : null}
          {points.map((p, idx) => (
            <circle key={idx} cx={p.x} cy={p.y} r="5" fill="hsl(var(--foreground))" fillOpacity="0.85" />
          ))}
        </svg>

        <div className="flex h-full items-end gap-3">
          {data.map((d) => {
            const inflowH = Math.round(Math.max(0, d.inflow) * scale)
            const outflowH = Math.round(Math.max(0, d.outflow) * scale)
            const active = selectedLabel === d.label
          return (
            <button
              key={d.label}
              type="button"
              onClick={() => onSelect(d.label)}
              className={[
                "flex h-full flex-1 flex-col justify-end gap-2 rounded-md px-1",
                active ? "bg-primary/5" : "hover:bg-muted/40",
              ].join(" ")}
              title={`${d.label}: Inflow ${fmtMoney(d.inflow)} / Outflow ${fmtMoney(-d.outflow)} / Net ${fmtMoney(d.net)}`}
            >
              <div className="relative h-[160px]">
                <div
                  className={[
                    "absolute left-1/2 w-8 -translate-x-1/2 rounded-md transition-colors",
                    "bg-emerald-500/70",
                    active ? "ring-2 ring-primary/30" : "",
                  ].join(" ")}
                  style={{
                    height: `${inflowH}px`,
                    bottom: "50%",
                  }}
                />
                <div
                  className={[
                    "absolute left-1/2 w-8 -translate-x-1/2 rounded-md transition-colors",
                    "bg-sky-500/55",
                    active ? "ring-2 ring-primary/30" : "",
                  ].join(" ")}
                  style={{
                    height: `${outflowH}px`,
                    top: "50%",
                  }}
                />
              </div>
              <div className="text-center text-xs text-muted-foreground">{d.label}</div>
            </button>
          )
        })}
        </div>

        <div className="mt-3 flex items-center gap-4 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <span className="inline-block h-2 w-2 rounded-sm bg-emerald-500/70" /> Inflow
          </div>
          <div className="flex items-center gap-2">
            <span className="inline-block h-2 w-2 rounded-sm bg-sky-500/55" /> Outflow
          </div>
          <div className="flex items-center gap-2">
            <span className="inline-block h-2 w-2 rounded-full bg-foreground/80" /> Net
          </div>
        </div>
      </div>
    </div>
  )
}

function MiniTrend({
  months,
}: {
  months: Array<{ label: string; income: string; expense: string }>
}) {
  const data = months.map((m) => ({
    label: m.label,
    income: Number(m.income ?? 0),
    expense: Number(m.expense ?? 0),
  }))
  const max = Math.max(1, ...data.flatMap((d) => [d.income, d.expense]))
  return (
    <div className="h-56 w-full rounded-xl border bg-background/60 p-4">
      <div className="flex h-full items-end gap-2">
        {data.map((d) => {
          const incH = Math.round((d.income / max) * 140)
          const expH = Math.round((d.expense / max) * 140)
          return (
            <div key={d.label} className="flex h-full flex-1 flex-col justify-end gap-2">
              <div className="relative h-[160px]">
                <div className="absolute inset-x-0 bottom-0 flex items-end justify-center gap-1">
                  <div
                    className="w-3 rounded-md bg-primary/80"
                    style={{ height: `${incH}px` }}
                    title={`${d.label} income: ${fmtMoney(d.income)}`}
                  />
                  <div
                    className="w-3 rounded-md bg-muted-foreground/35"
                    style={{ height: `${expH}px` }}
                    title={`${d.label} expense: ${fmtMoney(d.expense)}`}
                  />
                </div>
              </div>
              <div className="text-center text-xs text-muted-foreground">{d.label}</div>
            </div>
          )
        })}
      </div>
      <div className="mt-3 flex items-center gap-4 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-sm bg-primary/80" /> Income
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-sm bg-muted-foreground/35" /> Expense
        </div>
      </div>
    </div>
  )
}

function Donut({
  slices,
}: {
  slices: Array<{ label: string; value: number; color: string }>
}) {
  const total = slices.reduce((s, x) => s + x.value, 0) || 1
  let acc = 0
  const r = 44
  const c = 54
  const circ = 2 * Math.PI * r
  return (
    <div className="flex items-center gap-5">
      <svg width="120" height="120" viewBox="0 0 120 120" className="shrink-0">
        <circle cx={60} cy={60} r={r} fill="none" stroke="hsl(var(--muted))" strokeWidth="14" />
        {slices.map((s) => {
          const start = acc / total
          acc += s.value
          const frac = s.value / total
          const dash = `${frac * circ} ${circ}`
          const offset = (1 - start) * circ
          return (
            <circle
              key={s.label}
              cx={60}
              cy={60}
              r={r}
              fill="none"
              stroke={s.color}
              strokeWidth="14"
              strokeDasharray={dash}
              strokeDashoffset={offset}
              strokeLinecap="butt"
            />
          )
        })}
        <circle cx={60} cy={60} r={28} fill="hsl(var(--background))" />
        <text x={60} y={62} textAnchor="middle" className="fill-foreground" fontSize="11" fontWeight="600">
          EXPENSES
        </text>
      </svg>
      <div className="min-w-0 flex-1 space-y-2">
        {slices.map((s) => (
          <div key={s.label} className="flex items-center justify-between gap-3 text-sm">
            <div className="flex min-w-0 items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
              <div className="truncate text-muted-foreground">{s.label}</div>
            </div>
            <div className="tabular-nums font-medium">{fmtMoney(s.value)}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function Dashboard() {
  const { user, isLoading, companySettings } = useAuth()
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [selectedBucket, setSelectedBucket] = useState<string | null>(null)

  useEffect(() => {
    if (!user?.companyId) return
    const tz = companySettings?.timeZone ?? "Asia/Yangon"
    const today = todayInTimeZone(tz)
    const parts = today.split("-").map((x) => Number(x))
    const y = parts[0]
    const m = parts[1] // 1-12
    if (!y || !m) return

    const from = formatDateInputInTimeZone(new Date(Date.UTC(y, m - 1, 1)), tz)
    const to = formatDateInputInTimeZone(new Date(Date.UTC(y, m, 0)), tz)

    setLoading(true)
    fetchApi(`/companies/${user.companyId}/dashboard?from=${from}&to=${to}`)
      .then(setData)
      .catch((err) => {
        console.error(err)
        setData(null)
      })
      .finally(() => setLoading(false))
  }, [user?.companyId, companySettings?.timeZone])

  const buckets = useMemo(
    () => (data?.cashflow?.buckets ?? []) as Array<{ label: string; net: string; inflow?: string; outflow?: string; from?: string; to?: string }>,
    [data]
  )
  const coa = useMemo(() => (data?.coa?.topMovements ?? []) as Array<any>, [data])
  const trend = useMemo(() => (data?.trend?.incomeVsExpense ?? []) as Array<any>, [data])
  const expTop = useMemo(() => (data?.expenses?.top ?? []) as Array<any>, [data])
  const expOthers = useMemo(() => Number(data?.expenses?.othersAmount ?? 0), [data])

  if (isLoading || !user) return null

  const expenseSlices = (() => {
    const palette = ["#22c55e", "#10b981", "#06b6d4", "#60a5fa", "#a78bfa", "#94a3b8"]
    const rows = expTop.map((r, i) => ({
      label: String(r?.name ?? r?.code ?? "Expense"),
      value: Number(r?.amount ?? 0),
      color: palette[i % palette.length],
    }))
    if (expOthers > 0) rows.push({ label: "Others", value: expOthers, color: palette[5] })
    return rows.filter((r) => r.value > 0)
  })()

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <div className="text-sm text-muted-foreground">A quick snapshot of how your business is doing.</div>
        </div>
        <div className="relative w-[280px]">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input className="pl-8" placeholder="Search" />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Accounts Receivable</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center justify-between">
            <div className="text-3xl font-semibold tabular-nums">{loading ? "—" : fmtK(data?.kpis?.receivable)}</div>
            <Link href="/invoices/new">
              <Button variant="secondary" className="gap-2">
                <Plus className="h-4 w-4" /> New Invoice
              </Button>
            </Link>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Accounts Payable</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center justify-between">
            <div className="text-3xl font-semibold tabular-nums">{loading ? "—" : fmtK(data?.kpis?.payable)}</div>
            <Link href="/purchase-bills/new">
              <Button variant="secondary" className="gap-2">
                <Plus className="h-4 w-4" /> New Bill
              </Button>
            </Link>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Cash balance</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center justify-between">
            <div className="text-3xl font-semibold tabular-nums">{loading ? "—" : fmtK(data?.kpis?.cashBalance)}</div>
            <Link href="/banking">
              <Button variant="secondary" className="gap-2">
                View
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="shadow-sm md:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>Cashflow</CardTitle>
              <div className="text-sm text-muted-foreground">
                In K. Cash in and out of the organization.{" "}
                <Link href="/reports/cashflow" className="text-primary hover:underline">
                  Details <ArrowRight className="inline h-4 w-4" />
                </Link>
              </div>
            </div>
            <div className="text-sm text-muted-foreground">{data?.from ? new Date(data.from).toLocaleDateString() : ""}</div>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="text-center py-10 text-muted-foreground">Loading…</div>
            ) : buckets.length === 0 ? (
              <div className="text-center py-10 text-muted-foreground">No cashflow data yet.</div>
            ) : (
              <ZeroBaselineBars buckets={buckets} selectedLabel={selectedBucket} onSelect={setSelectedBucket} />
            )}
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Top expenses</CardTitle>
            <Link href="/accounts" className="text-sm text-muted-foreground hover:text-foreground">
              More <ArrowRight className="inline h-4 w-4" />
            </Link>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="text-center py-10 text-muted-foreground">Loading…</div>
            ) : expenseSlices.length === 0 ? (
              <div className="py-10 text-center text-muted-foreground">No expense data yet.</div>
                ) : (
              <Donut slices={expenseSlices} />
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="shadow-sm md:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>Income vs Expense</CardTitle>
              <div className="text-sm text-muted-foreground">Last 12 months (accrual)</div>
            </div>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="text-center py-10 text-muted-foreground">Loading…</div>
            ) : trend.length === 0 ? (
              <div className="text-center py-10 text-muted-foreground">No data yet.</div>
            ) : (
              <MiniTrend months={trend} />
            )}
          </CardContent>
        </Card>

        <Card className="shadow-sm md:col-span-1">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Reports</CardTitle>
            <Link href="/reports" className="text-sm text-muted-foreground hover:text-foreground">
              More <ArrowRight className="inline h-4 w-4" />
            </Link>
          </CardHeader>
          <CardContent className="space-y-2">
            <Link href="/reports/trial-balance" className="flex items-center justify-between rounded-md px-2 py-2 hover:bg-muted">
              <span className="text-sm">Trial Balance</span>
              <ArrowRight className="h-4 w-4 text-muted-foreground" />
            </Link>
            <Link href="/reports/balance-sheet" className="flex items-center justify-between rounded-md px-2 py-2 hover:bg-muted">
              <span className="text-sm">Balance Sheet</span>
              <ArrowRight className="h-4 w-4 text-muted-foreground" />
            </Link>
            <Link href="/reports/profit-loss" className="flex items-center justify-between rounded-md px-2 py-2 hover:bg-muted">
              <span className="text-sm">Profit &amp; Loss</span>
              <ArrowRight className="h-4 w-4 text-muted-foreground" />
            </Link>
            <Link href="/reports/cashflow" className="flex items-center justify-between rounded-md px-2 py-2 hover:bg-muted">
              <span className="text-sm">Cashflow</span>
              <ArrowRight className="h-4 w-4 text-muted-foreground" />
            </Link>
            <Link href="/ledger" className="flex items-center justify-between rounded-md px-2 py-2 hover:bg-muted">
              <span className="text-sm">Ledger</span>
              <ArrowRight className="h-4 w-4 text-muted-foreground" />
            </Link>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
