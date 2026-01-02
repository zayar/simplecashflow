"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { Pencil, Plus, Trash2 } from "lucide-react"

import { useAuth } from "@/contexts/auth-context"
import {
  createCurrency,
  createExchangeRate,
  deleteCurrency,
  getCurrenciesOverview,
  getExchangeRates,
  updateCurrency,
  type CurrencyOverviewRow,
  type CurrenciesOverview,
  type ExchangeRateRow,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

function normalizeCode(input: string) {
  return (input ?? "").trim().toUpperCase()
}

function formatDateShort(iso: string | null) {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toISOString().slice(0, 10)
}

export default function CurrenciesPage() {
  const { user, companySettings } = useAuth()

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [overview, setOverview] = useState<CurrenciesOverview | null>(null)

  const baseCurrency = useMemo(() => {
    const cur = (companySettings?.baseCurrency ?? "").trim().toUpperCase()
    return cur || null
  }, [companySettings?.baseCurrency])

  const [newCurrency, setNewCurrency] = useState({ code: "", name: "", symbol: "" })

  const [rateDialogOpen, setRateDialogOpen] = useState(false)
  const [rateTarget, setRateTarget] = useState<CurrencyOverviewRow | null>(null)
  const [rateForm, setRateForm] = useState({ rateToBase: "", asOfDate: "" })
  const [rateHistory, setRateHistory] = useState<ExchangeRateRow[] | null>(null)
  const [rateHistoryLoading, setRateHistoryLoading] = useState(false)

  const [editDialogOpen, setEditDialogOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<CurrencyOverviewRow | null>(null)
  const [editForm, setEditForm] = useState({ name: "", symbol: "" })

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<CurrencyOverviewRow | null>(null)

  const refresh = async () => {
    if (!user?.companyId) return
    setLoading(true)
    try {
      const data = await getCurrenciesOverview(user.companyId)
      setOverview(data)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh().catch(console.error)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.companyId])

  const onAddCurrency = async () => {
    if (!user?.companyId) return
    const code = normalizeCode(newCurrency.code)
    if (!/^[A-Z]{3}$/.test(code)) {
      alert("Currency code must be 3 letters (e.g. USD, MMK).")
      return
    }

    setSaving(true)
    try {
      await createCurrency(user.companyId, {
        code,
        name: newCurrency.name ? newCurrency.name.trim() : null,
        symbol: newCurrency.symbol ? newCurrency.symbol.trim() : null,
      })
      setNewCurrency({ code: "", name: "", symbol: "" })
      await refresh()
    } catch (err: any) {
      console.error(err)
      alert(err.message || "Failed to add currency")
    } finally {
      setSaving(false)
    }
  }

  const openRateDialog = async (row: CurrencyOverviewRow) => {
    const today = new Date().toISOString().slice(0, 10)
    setRateTarget(row)
    setRateForm({ rateToBase: row.latestRateToBase ?? "", asOfDate: today })
    setRateHistory(null)
    setRateDialogOpen(true)

    if (!user?.companyId) return
    if (!baseCurrency) return
    setRateHistoryLoading(true)
    try {
      const rows = await getExchangeRates(user.companyId, row.code)
      setRateHistory(rows)
    } catch (err) {
      console.error(err)
      setRateHistory([])
    } finally {
      setRateHistoryLoading(false)
    }
  }

  const onSaveRate = async () => {
    if (!user?.companyId || !rateTarget) return
    if (!baseCurrency) {
      alert("Please set a company base currency first.")
      return
    }
    const n = Number(rateForm.rateToBase)
    if (!Number.isFinite(n) || n <= 0) {
      alert("Exchange rate must be a positive number.")
      return
    }
    if (!rateForm.asOfDate) {
      alert("Please choose an As of date.")
      return
    }

    setSaving(true)
    try {
      await createExchangeRate(user.companyId, rateTarget.code, {
        rateToBase: n,
        asOfDate: rateForm.asOfDate,
      })
      // Refresh dialog history (best-effort)
      try {
        const rows = await getExchangeRates(user.companyId, rateTarget.code)
        setRateHistory(rows)
      } catch {
        // ignore
      }
      setRateDialogOpen(false)
      setRateTarget(null)
      await refresh()
    } catch (err: any) {
      console.error(err)
      alert(err.message || "Failed to save exchange rate")
    } finally {
      setSaving(false)
    }
  }

  const openEditDialog = (row: CurrencyOverviewRow) => {
    setEditTarget(row)
    setEditForm({ name: row.name ?? "", symbol: row.symbol ?? "" })
    setEditDialogOpen(true)
  }

  const onSaveCurrencyEdit = async () => {
    if (!user?.companyId || !editTarget) return
    setSaving(true)
    try {
      await updateCurrency(user.companyId, editTarget.id, {
        name: editForm.name ? editForm.name.trim() : null,
        symbol: editForm.symbol ? editForm.symbol.trim() : null,
      })
      setEditDialogOpen(false)
      setEditTarget(null)
      await refresh()
    } catch (err: any) {
      console.error(err)
      alert(err.message || "Failed to update currency")
    } finally {
      setSaving(false)
    }
  }

  const openDeleteDialog = (row: CurrencyOverviewRow) => {
    setDeleteTarget(row)
    setDeleteDialogOpen(true)
  }

  const onConfirmDelete = async () => {
    if (!user?.companyId || !deleteTarget) return
    setSaving(true)
    try {
      await deleteCurrency(user.companyId, deleteTarget.id)
      setDeleteDialogOpen(false)
      setDeleteTarget(null)
      await refresh()
    } catch (err: any) {
      console.error(err)
      alert(err.message || "Failed to disable currency")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Currencies</h1>
          <p className="text-sm text-muted-foreground">
            Manage currencies and reference exchange rates (display-only).
          </p>
        </div>
      </div>

      {!baseCurrency ? (
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">Base currency required</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Exchange rates are stored relative to your company base currency. Please set it first.
            </p>
            <Link href="/settings">
              <Button variant="outline" size="sm">
                Go to Company Profile
              </Button>
            </Link>
          </CardContent>
        </Card>
      ) : null}

      <Card className="shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-lg">Add currency</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-4">
          <div className="grid gap-2">
            <Label>Code</Label>
            <Input
              value={newCurrency.code}
              onChange={(e) => setNewCurrency((p) => ({ ...p, code: e.target.value }))}
              placeholder="USD"
              maxLength={3}
            />
          </div>
          <div className="grid gap-2">
            <Label>Name (optional)</Label>
            <Input
              value={newCurrency.name}
              onChange={(e) => setNewCurrency((p) => ({ ...p, name: e.target.value }))}
              placeholder="US Dollar"
            />
          </div>
          <div className="grid gap-2">
            <Label>Symbol (optional)</Label>
            <Input
              value={newCurrency.symbol}
              onChange={(e) => setNewCurrency((p) => ({ ...p, symbol: e.target.value }))}
              placeholder="$"
            />
          </div>
          <div className="flex items-end">
            <Button onClick={onAddCurrency} disabled={saving}>
              <Plus className="mr-2 h-4 w-4" />
              Add
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-lg">All currencies</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {loading ? (
            <div className="py-10 text-center text-sm text-muted-foreground">Loading…</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[110px]">Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead className="w-[110px]">Symbol</TableHead>
                  <TableHead className="w-[220px]">
                    Exchange rate {baseCurrency ? `(${baseCurrency})` : ""}
                  </TableHead>
                  <TableHead className="w-[140px]">As of</TableHead>
                  <TableHead className="w-[140px] text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(overview?.currencies ?? []).map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">
                      {c.code}
                      {c.isBase ? (
                        <span className="ml-2 rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                          Base
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{c.name || "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{c.symbol || "—"}</TableCell>
                    <TableCell className="font-mono text-sm">
                      {c.isBase ? "—" : c.latestRateToBase ?? "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {c.isBase ? "—" : formatDateShort(c.latestAsOfDate)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button variant="outline" size="sm" onClick={() => openEditDialog(c)}>
                          <Pencil className="mr-2 h-4 w-4" />
                          Edit
                        </Button>
                        {!c.isBase ? (
                          <>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => openRateDialog(c)}
                              disabled={!baseCurrency}
                            >
                              View rates
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => openDeleteDialog(c)}
                              disabled={saving}
                            >
                              <Trash2 className="mr-2 h-4 w-4" />
                              Disable
                            </Button>
                          </>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}

                {(overview?.currencies?.length ?? 0) === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                      No currencies yet. Add one above.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={rateDialogOpen} onOpenChange={setRateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Exchange rates</DialogTitle>
            <DialogDescription>
              {rateTarget?.code} → {baseCurrency}. Stored for reference only (no impact on ledger posting).
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="grid gap-2">
                <Label>Rate (1 {rateTarget?.code} = ? {baseCurrency})</Label>
                <Input
                  value={rateForm.rateToBase}
                  onChange={(e) => setRateForm((p) => ({ ...p, rateToBase: e.target.value }))}
                  placeholder="0.00"
                  inputMode="decimal"
                />
              </div>
              <div className="grid gap-2">
                <Label>As of date</Label>
                <Input
                  type="date"
                  value={rateForm.asOfDate}
                  onChange={(e) => setRateForm((p) => ({ ...p, asOfDate: e.target.value }))}
                />
              </div>
            </div>

            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[120px]">As of</TableHead>
                    <TableHead>Rate</TableHead>
                    <TableHead className="w-[140px]">Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rateHistoryLoading ? (
                    <TableRow>
                      <TableCell colSpan={3} className="py-8 text-center text-sm text-muted-foreground">
                        Loading rates…
                      </TableCell>
                    </TableRow>
                  ) : (rateHistory?.length ?? 0) > 0 ? (
                    (rateHistory ?? []).map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="text-muted-foreground">{formatDateShort(r.asOfDate)}</TableCell>
                        <TableCell className="font-mono text-sm">{r.rateToBase}</TableCell>
                        <TableCell className="text-muted-foreground">{formatDateShort(r.createdAt)}</TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell colSpan={3} className="py-8 text-center text-sm text-muted-foreground">
                        No rates yet.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setRateDialogOpen(false)}>
              Close
            </Button>
            <Button onClick={onSaveRate} disabled={saving}>
              {saving ? "Saving..." : "Save rate"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit currency</DialogTitle>
            <DialogDescription>Update display metadata. Currency code can’t be changed.</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label>Code</Label>
              <Input value={editTarget?.code ?? ""} disabled />
            </div>
            <div className="grid gap-2">
              <Label>Name</Label>
              <Input
                value={editForm.name}
                onChange={(e) => setEditForm((p) => ({ ...p, name: e.target.value }))}
                placeholder="US Dollar"
              />
            </div>
            <div className="grid gap-2">
              <Label>Symbol</Label>
              <Input
                value={editForm.symbol}
                onChange={(e) => setEditForm((p) => ({ ...p, symbol: e.target.value }))}
                placeholder="$"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={onSaveCurrencyEdit} disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disable currency</DialogTitle>
            <DialogDescription>
              This will hide the currency from lists. It does not change any accounting data.
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-md border p-3 text-sm">
            <div>
              <span className="text-muted-foreground">Currency:</span>{" "}
              <span className="font-medium">{deleteTarget?.code}</span>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={onConfirmDelete} disabled={saving}>
              {saving ? "Disabling..." : "Disable"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}


