/* eslint-disable react-hooks/exhaustive-deps */
"use client"

import { useEffect, useMemo, useState } from "react"
import { ChevronDown, Plus } from "lucide-react"

import { fetchApi } from "@/lib/api"
import { todayInTimeZone } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { SelectNative } from "@/components/ui/select-native"
import { Textarea } from "@/components/ui/textarea"

type Flow =
  | "expense"
  | "transfer_out"
  | "vendor_payment"
  | "customer_payment"
  | "sales_no_invoice"
  | "other_income"
  | "transfer_in"

function toNumber(v: string): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : NaN
}

function bankKindToPaymentMode(kind: string | null | undefined): "CASH" | "BANK" | "E_WALLET" {
  if (kind === "CASH") return "CASH"
  if (kind === "E_WALLET") return "E_WALLET"
  return "BANK"
}

export function AddTransaction({
  companyId,
  timeZone,
  bankKind,
  bankAccountCoaId,
  bankAccountLabel,
  onDone,
}: {
  companyId: number
  timeZone: string
  bankKind: string
  bankAccountCoaId: number
  bankAccountLabel: string
  onDone?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [flow, setFlow] = useState<Flow | null>(null)
  const [loading, setLoading] = useState(false)

  const paymentMode = useMemo(() => bankKindToPaymentMode(bankKind), [bankKind])

  // Shared lookups
  const [bankingAccounts, setBankingAccounts] = useState<any[]>([])
  const [expenseAccounts, setExpenseAccounts] = useState<any[]>([])
  const [incomeAccounts, setIncomeAccounts] = useState<any[]>([])
  const [vendors, setVendors] = useState<any[]>([])
  const [purchaseBills, setPurchaseBills] = useState<any[]>([])
  const [invoices, setInvoices] = useState<any[]>([])

  // Money Out: Expense
  const [exp, setExp] = useState({
    expenseDate: "",
    amount: "",
    expenseAccountId: "",
    vendorId: "",
    reference: "",
    description: "",
  })

  // Money Out: Transfer to another account
  const [tOut, setTOut] = useState({
    date: "",
    amount: "",
    toBankAccountId: "", // COA accountId for destination
    reference: "",
    description: "",
  })

  // Money Out: Vendor payment (purchase bill payment)
  const [vp, setVp] = useState({
    paymentDate: "",
    purchaseBillId: "",
    amount: "",
    reference: "",
    description: "",
  })

  // Money In: Customer payment (invoice payment)
  const [cp, setCp] = useState({
    paymentDate: "",
    invoiceId: "",
    amount: "",
    reference: "",
    description: "",
  })
  const [selectedInvoice, setSelectedInvoice] = useState<any>(null)

  // Money In: Sales without invoices
  const [swi, setSwi] = useState({
    date: "",
    amount: "",
    revenueAccountId: "",
    reference: "",
    description: "",
  })

  // Money In: Other income
  const [oi, setOi] = useState({
    date: "",
    amount: "",
    incomeAccountId: "",
    reference: "",
    description: "",
  })

  // Money In: Transfer from another account
  const [tIn, setTIn] = useState({
    date: "",
    amount: "",
    fromBankAccountId: "", // COA accountId for source
    reference: "",
    description: "",
  })

  const resetForFlow = (f: Flow) => {
    const today = todayInTimeZone(timeZone)
    setLoading(false)
    setSelectedInvoice(null)
    if (f === "expense") {
      setExp({ expenseDate: today, amount: "", expenseAccountId: "", vendorId: "", reference: "", description: "" })
    } else if (f === "transfer_out") {
      setTOut({ date: today, amount: "", toBankAccountId: "", reference: "", description: "" })
    } else if (f === "vendor_payment") {
      setVp({ paymentDate: today, purchaseBillId: "", amount: "", reference: "", description: "" })
    } else if (f === "customer_payment") {
      setCp({ paymentDate: today, invoiceId: "", amount: "", reference: "", description: "" })
    } else if (f === "sales_no_invoice") {
      setSwi({ date: today, amount: "", revenueAccountId: "", reference: "", description: "" })
    } else if (f === "other_income") {
      setOi({ date: today, amount: "", incomeAccountId: "", reference: "", description: "" })
    } else if (f === "transfer_in") {
      setTIn({ date: today, amount: "", fromBankAccountId: "", reference: "", description: "" })
    }
  }

  const openFlow = (f: Flow) => {
    setFlow(f)
    resetForFlow(f)
    setOpen(true)
  }

  // Load shared lookups once (lazy, but only when dialog is used)
  useEffect(() => {
    if (!open) return
    // Always keep banking accounts handy for transfers / fixed labels.
    fetchApi(`/companies/${companyId}/banking-accounts`).then(setBankingAccounts).catch(console.error)
    // Load accounts for Income/Expense selection (used by several flows).
    fetchApi(`/companies/${companyId}/accounts`)
      .then((all) => {
        const rows = Array.isArray(all) ? all : []
        setExpenseAccounts(rows.filter((a: any) => a.type === "EXPENSE"))
        setIncomeAccounts(rows.filter((a: any) => a.type === "INCOME"))
      })
      .catch(console.error)
  }, [open, companyId])

  // Flow-specific lookups
  useEffect(() => {
    if (!open || !flow) return
    if (flow === "expense") {
      fetchApi(`/companies/${companyId}/vendors`).then(setVendors).catch(console.error)
    }
    if (flow === "vendor_payment") {
      fetchApi(`/companies/${companyId}/purchase-bills`).then(setPurchaseBills).catch(console.error)
    }
    if (flow === "customer_payment") {
      fetchApi(`/companies/${companyId}/invoices`).then(setInvoices).catch(console.error)
    }
  }, [open, flow, companyId])

  // When invoice selected, fetch detail to get remaining balance and auto-fill amount.
  useEffect(() => {
    if (!open || flow !== "customer_payment") return
    if (!cp.invoiceId) {
      setSelectedInvoice(null)
      return
    }
    fetchApi(`/companies/${companyId}/invoices/${cp.invoiceId}`)
      .then((inv) => {
        setSelectedInvoice(inv)
        const remaining = Number(inv?.remainingBalance ?? 0)
        if (!cp.amount && remaining > 0) {
          setCp((prev) => ({ ...prev, amount: remaining.toFixed(2) }))
        }
      })
      .catch((e) => {
        console.error(e)
        setSelectedInvoice(null)
      })
  }, [open, flow, cp.invoiceId])

  const otherBankingAccounts = useMemo(() => {
    return (bankingAccounts ?? []).filter((b: any) => Number(b?.account?.id) && Number(b.account.id) !== bankAccountCoaId)
  }, [bankingAccounts, bankAccountCoaId])

  const payablePurchaseBills = useMemo(() => {
    const rows = Array.isArray(purchaseBills) ? purchaseBills : []
    return rows
      .map((b: any) => {
        const total = Number(b.total ?? 0)
        const paid = Number(b.amountPaid ?? 0)
        const remaining = Math.max(0, total - paid)
        return { ...b, _remaining: remaining }
      })
      .filter((b: any) => (b.status === "POSTED" || b.status === "PARTIAL") && b._remaining > 0)
  }, [purchaseBills])

  useEffect(() => {
    if (!open || flow !== "vendor_payment") return
    if (!vp.purchaseBillId) return
    const bill = payablePurchaseBills.find((b: any) => String(b.id) === String(vp.purchaseBillId))
    if (!bill) return
    if (!vp.amount && Number(bill._remaining) > 0) {
      setVp((prev) => ({ ...prev, amount: Number(bill._remaining).toFixed(2) }))
    }
  }, [open, flow, vp.purchaseBillId, payablePurchaseBills])

  const close = () => {
    setOpen(false)
    setFlow(null)
    setLoading(false)
  }

  const submit = async () => {
    if (!flow) return
    setLoading(true)
    try {
      if (flow === "expense") {
        const amount = toNumber(exp.amount)
        if (!amount || amount <= 0) throw new Error("Amount must be > 0")
        if (!exp.expenseAccountId) throw new Error("Please select an expense account")
        const expenseAccountId = Number(exp.expenseAccountId)
        const vendorId = exp.vendorId ? Number(exp.vendorId) : null
        let description = String(exp.description ?? "")
        if (exp.reference) description = `Ref: ${exp.reference} - ${description}`
        if (!description.trim()) description = "Expense"

        const bill = await fetchApi(`/companies/${companyId}/expenses`, {
          method: "POST",
          body: JSON.stringify({
            vendorId,
            expenseDate: exp.expenseDate,
            description,
            amount,
            expenseAccountId,
          }),
        })

        await fetchApi(`/companies/${companyId}/expenses/${bill.id}/post`, {
          method: "POST",
          body: JSON.stringify({ bankAccountId: bankAccountCoaId }),
        })
      }

      if (flow === "transfer_out") {
        const amount = toNumber(tOut.amount)
        if (!amount || amount <= 0) throw new Error("Amount must be > 0")
        if (!tOut.toBankAccountId) throw new Error("Please select a destination account")
        const toAccountId = Number(tOut.toBankAccountId)
        if (toAccountId === bankAccountCoaId) throw new Error("Destination account must be different")

        let description = String(tOut.description ?? "")
        if (tOut.reference) description = `Ref: ${tOut.reference} - ${description}`
        if (!description.trim()) {
          const dest = otherBankingAccounts.find((b: any) => Number(b?.account?.id) === toAccountId)
          description = `Transfer to ${dest?.account?.name ?? "another account"}`
        }

        await fetchApi(`/companies/${companyId}/journal-entries`, {
          method: "POST",
          body: JSON.stringify({
            date: tOut.date,
            description,
            lines: [
              { accountId: toAccountId, debit: amount, credit: 0 },
              { accountId: bankAccountCoaId, debit: 0, credit: amount },
            ],
          }),
        })
      }

      if (flow === "vendor_payment") {
        if (!vp.purchaseBillId) throw new Error("Please select a purchase bill")
        const amount = toNumber(vp.amount)
        if (!amount || amount <= 0) throw new Error("Amount must be > 0")
        const bill = payablePurchaseBills.find((b: any) => String(b.id) === String(vp.purchaseBillId))
        if (!bill) throw new Error("Selected purchase bill is not payable")
        if (amount > Number(bill._remaining ?? 0)) throw new Error("Amount cannot exceed remaining balance")

        await fetchApi(`/companies/${companyId}/purchase-bills/${vp.purchaseBillId}/payments`, {
          method: "POST",
          body: JSON.stringify({
            paymentDate: vp.paymentDate,
            amount,
            bankAccountId: bankAccountCoaId,
          }),
        })
      }

      if (flow === "customer_payment") {
        if (!cp.invoiceId) throw new Error("Please select an invoice")
        const amount = toNumber(cp.amount)
        if (!amount || amount <= 0) throw new Error("Amount must be > 0")
        const remaining = Number(selectedInvoice?.remainingBalance ?? NaN)
        if (Number.isFinite(remaining) && amount > remaining) throw new Error("Amount cannot exceed remaining balance")

        await fetchApi(`/companies/${companyId}/invoices/${cp.invoiceId}/payments`, {
          method: "POST",
          body: JSON.stringify({
            paymentMode,
            paymentDate: cp.paymentDate,
            amount,
            bankAccountId: bankAccountCoaId,
          }),
        })
      }

      if (flow === "sales_no_invoice") {
        const amount = toNumber(swi.amount)
        if (!amount || amount <= 0) throw new Error("Amount must be > 0")
        if (!swi.revenueAccountId) throw new Error("Please select a revenue account")
        const revenueAccountId = Number(swi.revenueAccountId)

        let description = String(swi.description ?? "")
        if (swi.reference) description = `Ref: ${swi.reference} - ${description}`
        if (!description.trim()) description = "Sales without invoice"

        await fetchApi(`/companies/${companyId}/journal-entries`, {
          method: "POST",
          body: JSON.stringify({
            date: swi.date,
            description,
            lines: [
              { accountId: bankAccountCoaId, debit: amount, credit: 0 },
              { accountId: revenueAccountId, debit: 0, credit: amount },
            ],
          }),
        })
      }

      if (flow === "other_income") {
        const amount = toNumber(oi.amount)
        if (!amount || amount <= 0) throw new Error("Amount must be > 0")
        if (!oi.incomeAccountId) throw new Error("Please select an income account")
        const incomeAccountId = Number(oi.incomeAccountId)

        let description = String(oi.description ?? "")
        if (oi.reference) description = `Ref: ${oi.reference} - ${description}`
        if (!description.trim()) description = "Other income"

        await fetchApi(`/companies/${companyId}/journal-entries`, {
          method: "POST",
          body: JSON.stringify({
            date: oi.date,
            description,
            lines: [
              { accountId: bankAccountCoaId, debit: amount, credit: 0 },
              { accountId: incomeAccountId, debit: 0, credit: amount },
            ],
          }),
        })
      }

      if (flow === "transfer_in") {
        const amount = toNumber(tIn.amount)
        if (!amount || amount <= 0) throw new Error("Amount must be > 0")
        if (!tIn.fromBankAccountId) throw new Error("Please select a source account")
        const fromAccountId = Number(tIn.fromBankAccountId)
        if (fromAccountId === bankAccountCoaId) throw new Error("Source account must be different")

        let description = String(tIn.description ?? "")
        if (tIn.reference) description = `Ref: ${tIn.reference} - ${description}`
        if (!description.trim()) {
          const src = otherBankingAccounts.find((b: any) => Number(b?.account?.id) === fromAccountId)
          description = `Transfer from ${src?.account?.name ?? "another account"}`
        }

        await fetchApi(`/companies/${companyId}/journal-entries`, {
          method: "POST",
          body: JSON.stringify({
            date: tIn.date,
            description,
            lines: [
              { accountId: bankAccountCoaId, debit: amount, credit: 0 },
              { accountId: fromAccountId, debit: 0, credit: amount },
            ],
          }),
        })
      }

      close()
      onDone?.()
    } catch (e: any) {
      console.error(e)
      alert(e?.message ?? String(e))
      setLoading(false)
    }
  }

  const title = useMemo(() => {
    switch (flow) {
      case "expense":
        return "Expense (Money Out)"
      case "transfer_out":
        return "Transfer to Another Account (Money Out)"
      case "vendor_payment":
        return "Vendor Payment (Money Out)"
      case "customer_payment":
        return "Customer Payment (Money In)"
      case "sales_no_invoice":
        return "Sales Without Invoices (Money In)"
      case "other_income":
        return "Other Income (Money In)"
      case "transfer_in":
        return "Transfer From Another Account (Money In)"
      default:
        return "Add Transaction"
    }
  }, [flow])

  const description = useMemo(() => {
    switch (flow) {
      case "expense":
        return `Record an expense paid from ${bankAccountLabel}.`
      case "transfer_out":
        return `Move money out from ${bankAccountLabel} to another deposit account.`
      case "vendor_payment":
        return `Pay a posted purchase bill from ${bankAccountLabel}.`
      case "customer_payment":
        return `Record a customer payment deposited to ${bankAccountLabel}.`
      case "sales_no_invoice":
        return `Record sales income directly into ${bankAccountLabel} (no invoice).`
      case "other_income":
        return `Record other income directly into ${bankAccountLabel}.`
      case "transfer_in":
        return `Move money into ${bankAccountLabel} from another deposit account.`
      default:
        return ""
    }
  }, [flow, bankAccountLabel])

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button className="gap-2">
            <Plus className="h-4 w-4" />
            Add Transaction
            <ChevronDown className="h-4 w-4 opacity-80" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[260px]">
          <DropdownMenuLabel>Choose type</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Money Out</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-[260px]">
              <DropdownMenuItem onSelect={() => openFlow("expense")}>Expense</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => openFlow("transfer_out")}>Transfer to Another Account</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => openFlow("vendor_payment")}>Vendor Payment</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Money In</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-[260px]">
              <DropdownMenuItem onSelect={() => openFlow("customer_payment")}>Customer Payment</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => openFlow("sales_no_invoice")}>Sales Without Invoices</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => openFlow("other_income")}>Other Income</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => openFlow("transfer_in")}>Transfer From Another Account</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={open} onOpenChange={(v) => (v ? setOpen(true) : close())}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>

          {/* Common: Bank account fixed */}
          <div className="grid gap-3 rounded-lg border bg-muted/20 p-4 text-sm">
            <div className="grid gap-1">
              <div className="text-xs text-muted-foreground">Bank account</div>
              <div className="font-medium">{bankAccountLabel}</div>
              <div className="text-xs text-muted-foreground">
                This transaction will use the current bank account (no Reporting Tags / Uploads).
              </div>
            </div>
          </div>

          {/* Flow: Expense */}
          {flow === "expense" ? (
            <div className="grid gap-6 md:grid-cols-2">
              <div className="space-y-4">
                <div className="grid gap-2">
                  <Label>Date*</Label>
                  <Input type="date" value={exp.expenseDate} onChange={(e) => setExp({ ...exp, expenseDate: e.target.value })} />
                </div>
                <div className="grid gap-2">
                  <Label>Expense Account*</Label>
                  <SelectNative value={exp.expenseAccountId} onChange={(e) => setExp({ ...exp, expenseAccountId: e.target.value })}>
                    <option value="">Select an account</option>
                    {expenseAccounts.map((a: any) => (
                      <option key={a.id} value={a.id}>
                        {a.code} - {a.name}
                      </option>
                    ))}
                  </SelectNative>
                </div>
                <div className="grid gap-2">
                  <Label>Amount*</Label>
                  <div className="flex gap-2">
                    <SelectNative className="w-[100px]" disabled>
                      <option>MMK</option>
                    </SelectNative>
                    <Input
                      type="number"
                      inputMode="numeric"
                      step="1"
                      min="1"
                      value={exp.amount}
                      onChange={(e) => setExp({ ...exp, amount: e.target.value })}
                      placeholder="0"
                    />
                  </div>
                </div>
              </div>
              <div className="space-y-4">
                <div className="grid gap-2">
                  <Label>Vendor</Label>
                  <SelectNative value={exp.vendorId} onChange={(e) => setExp({ ...exp, vendorId: e.target.value })}>
                    <option value="">Select vendor (optional)</option>
                    {vendors.map((v: any) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </SelectNative>
                </div>
                <div className="grid gap-2">
                  <Label>Reference#</Label>
                  <Input value={exp.reference} onChange={(e) => setExp({ ...exp, reference: e.target.value })} placeholder="e.g. EXP-001" />
                </div>
                <div className="grid gap-2">
                  <Label>Description</Label>
                  <Textarea
                    value={exp.description}
                    onChange={(e) => setExp({ ...exp, description: e.target.value })}
                    placeholder="Max. 500 characters"
                    className="min-h-[110px]"
                  />
                </div>
              </div>
            </div>
          ) : null}

          {/* Flow: Transfer out */}
          {flow === "transfer_out" ? (
            <div className="grid gap-6 md:grid-cols-2">
              <div className="space-y-4">
                <div className="grid gap-2">
                  <Label>Date*</Label>
                  <Input type="date" value={tOut.date} onChange={(e) => setTOut({ ...tOut, date: e.target.value })} />
                </div>
                <div className="grid gap-2">
                  <Label>To Account*</Label>
                  <SelectNative value={tOut.toBankAccountId} onChange={(e) => setTOut({ ...tOut, toBankAccountId: e.target.value })}>
                    <option value="">Select an account</option>
                    {otherBankingAccounts.map((b: any) => (
                      <option key={b.id} value={b.account.id}>
                        {b.kind} - {b.account.code} {b.account.name}
                      </option>
                    ))}
                  </SelectNative>
                </div>
                <div className="grid gap-2">
                  <Label>Amount*</Label>
                  <div className="flex gap-2">
                    <SelectNative className="w-[100px]" disabled>
                      <option>MMK</option>
                    </SelectNative>
                    <Input
                      type="number"
                      inputMode="numeric"
                      step="1"
                      min="1"
                      value={tOut.amount}
                      onChange={(e) => setTOut({ ...tOut, amount: e.target.value })}
                      placeholder="0"
                    />
                  </div>
                </div>
              </div>
              <div className="space-y-4">
                <div className="grid gap-2">
                  <Label>Reference#</Label>
                  <Input value={tOut.reference} onChange={(e) => setTOut({ ...tOut, reference: e.target.value })} placeholder="optional" />
                </div>
                <div className="grid gap-2">
                  <Label>Description</Label>
                  <Textarea
                    value={tOut.description}
                    onChange={(e) => setTOut({ ...tOut, description: e.target.value })}
                    placeholder="optional"
                    className="min-h-[110px]"
                  />
                </div>
              </div>
            </div>
          ) : null}

          {/* Flow: Vendor payment */}
          {flow === "vendor_payment" ? (
            <div className="grid gap-6 md:grid-cols-2">
              <div className="space-y-4">
                <div className="grid gap-2">
                  <Label>Payment Date*</Label>
                  <Input type="date" value={vp.paymentDate} onChange={(e) => setVp({ ...vp, paymentDate: e.target.value })} />
                </div>
                <div className="grid gap-2">
                  <Label>Purchase Bill*</Label>
                  <SelectNative value={vp.purchaseBillId} onChange={(e) => setVp({ ...vp, purchaseBillId: e.target.value, amount: "" })}>
                    <option value="">Select a bill</option>
                    {payablePurchaseBills.map((b: any) => (
                      <option key={b.id} value={b.id}>
                        {b.billNumber} • {b.vendorName ?? "—"} • Remaining {Number(b._remaining).toLocaleString()}
                      </option>
                    ))}
                  </SelectNative>
                  <p className="text-xs text-muted-foreground">Only POSTED / PARTIAL bills with remaining balance are shown.</p>
                </div>
                <div className="grid gap-2">
                  <Label>Amount*</Label>
                  <div className="flex gap-2">
                    <SelectNative className="w-[100px]" disabled>
                      <option>MMK</option>
                    </SelectNative>
                    <Input
                      type="number"
                      inputMode="numeric"
                      step="0.01"
                      min="0.01"
                      value={vp.amount}
                      onChange={(e) => setVp({ ...vp, amount: e.target.value })}
                      placeholder="0"
                    />
                  </div>
                </div>
              </div>
              <div className="space-y-4">
                <div className="grid gap-2">
                  <Label>Reference#</Label>
                  <Input value={vp.reference} onChange={(e) => setVp({ ...vp, reference: e.target.value })} placeholder="optional" />
                </div>
                <div className="grid gap-2">
                  <Label>Description</Label>
                  <Textarea
                    value={vp.description}
                    onChange={(e) => setVp({ ...vp, description: e.target.value })}
                    placeholder="optional"
                    className="min-h-[110px]"
                  />
                </div>
              </div>
            </div>
          ) : null}

          {/* Flow: Customer payment */}
          {flow === "customer_payment" ? (
            <div className="grid gap-6 md:grid-cols-2">
              <div className="space-y-4">
                <div className="grid gap-2">
                  <Label>Payment Date*</Label>
                  <Input type="date" value={cp.paymentDate} onChange={(e) => setCp({ ...cp, paymentDate: e.target.value })} />
                </div>
                <div className="grid gap-2">
                  <Label>Invoice*</Label>
                  <SelectNative value={cp.invoiceId} onChange={(e) => setCp({ ...cp, invoiceId: e.target.value, amount: "" })}>
                    <option value="">Select an invoice</option>
                    {(Array.isArray(invoices) ? invoices : []).map((inv: any) => (
                      <option key={inv.id} value={inv.id}>
                        {inv.invoiceNumber} • {inv.customerName} • {inv.status}
                      </option>
                    ))}
                  </SelectNative>
                  {selectedInvoice ? (
                    <p className="text-xs text-muted-foreground">
                      Remaining: <b>{Number(selectedInvoice.remainingBalance ?? 0).toLocaleString()}</b>
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">Select an invoice to auto-fill remaining amount.</p>
                  )}
                </div>
                <div className="grid gap-2">
                  <Label>Amount*</Label>
                  <div className="flex gap-2">
                    <SelectNative className="w-[100px]" disabled>
                      <option>MMK</option>
                    </SelectNative>
                    <Input
                      type="number"
                      inputMode="numeric"
                      step="0.01"
                      min="0.01"
                      value={cp.amount}
                      onChange={(e) => setCp({ ...cp, amount: e.target.value })}
                      placeholder="0"
                    />
                  </div>
                </div>
                <div className="grid gap-2">
                  <Label>Received Via</Label>
                  <SelectNative disabled value={paymentMode}>
                    <option value="CASH">Cash</option>
                    <option value="BANK">Bank</option>
                    <option value="E_WALLET">E‑wallet</option>
                  </SelectNative>
                </div>
              </div>
              <div className="space-y-4">
                <div className="grid gap-2">
                  <Label>Reference#</Label>
                  <Input value={cp.reference} onChange={(e) => setCp({ ...cp, reference: e.target.value })} placeholder="optional" />
                </div>
                <div className="grid gap-2">
                  <Label>Description</Label>
                  <Textarea
                    value={cp.description}
                    onChange={(e) => setCp({ ...cp, description: e.target.value })}
                    placeholder="optional"
                    className="min-h-[110px]"
                  />
                </div>
              </div>
            </div>
          ) : null}

          {/* Flow: Sales without invoices */}
          {flow === "sales_no_invoice" ? (
            <div className="grid gap-6 md:grid-cols-2">
              <div className="space-y-4">
                <div className="grid gap-2">
                  <Label>Date*</Label>
                  <Input type="date" value={swi.date} onChange={(e) => setSwi({ ...swi, date: e.target.value })} />
                </div>
                <div className="grid gap-2">
                  <Label>Revenue Account*</Label>
                  <SelectNative value={swi.revenueAccountId} onChange={(e) => setSwi({ ...swi, revenueAccountId: e.target.value })}>
                    <option value="">Select an account</option>
                    {incomeAccounts.map((a: any) => (
                      <option key={a.id} value={a.id}>
                        {a.code} - {a.name}
                      </option>
                    ))}
                  </SelectNative>
                </div>
                <div className="grid gap-2">
                  <Label>Amount*</Label>
                  <div className="flex gap-2">
                    <SelectNative className="w-[100px]" disabled>
                      <option>MMK</option>
                    </SelectNative>
                    <Input
                      type="number"
                      inputMode="numeric"
                      step="1"
                      min="1"
                      value={swi.amount}
                      onChange={(e) => setSwi({ ...swi, amount: e.target.value })}
                      placeholder="0"
                    />
                  </div>
                </div>
              </div>
              <div className="space-y-4">
                <div className="grid gap-2">
                  <Label>Reference#</Label>
                  <Input value={swi.reference} onChange={(e) => setSwi({ ...swi, reference: e.target.value })} placeholder="optional" />
                </div>
                <div className="grid gap-2">
                  <Label>Description</Label>
                  <Textarea
                    value={swi.description}
                    onChange={(e) => setSwi({ ...swi, description: e.target.value })}
                    placeholder="optional"
                    className="min-h-[110px]"
                  />
                </div>
              </div>
            </div>
          ) : null}

          {/* Flow: Other income */}
          {flow === "other_income" ? (
            <div className="grid gap-6 md:grid-cols-2">
              <div className="space-y-4">
                <div className="grid gap-2">
                  <Label>Date*</Label>
                  <Input type="date" value={oi.date} onChange={(e) => setOi({ ...oi, date: e.target.value })} />
                </div>
                <div className="grid gap-2">
                  <Label>Income Account*</Label>
                  <SelectNative value={oi.incomeAccountId} onChange={(e) => setOi({ ...oi, incomeAccountId: e.target.value })}>
                    <option value="">Select an account</option>
                    {incomeAccounts.map((a: any) => (
                      <option key={a.id} value={a.id}>
                        {a.code} - {a.name}
                      </option>
                    ))}
                  </SelectNative>
                </div>
                <div className="grid gap-2">
                  <Label>Amount*</Label>
                  <div className="flex gap-2">
                    <SelectNative className="w-[100px]" disabled>
                      <option>MMK</option>
                    </SelectNative>
                    <Input
                      type="number"
                      inputMode="numeric"
                      step="1"
                      min="1"
                      value={oi.amount}
                      onChange={(e) => setOi({ ...oi, amount: e.target.value })}
                      placeholder="0"
                    />
                  </div>
                </div>
              </div>
              <div className="space-y-4">
                <div className="grid gap-2">
                  <Label>Reference#</Label>
                  <Input value={oi.reference} onChange={(e) => setOi({ ...oi, reference: e.target.value })} placeholder="optional" />
                </div>
                <div className="grid gap-2">
                  <Label>Description</Label>
                  <Textarea
                    value={oi.description}
                    onChange={(e) => setOi({ ...oi, description: e.target.value })}
                    placeholder="optional"
                    className="min-h-[110px]"
                  />
                </div>
              </div>
            </div>
          ) : null}

          {/* Flow: Transfer in */}
          {flow === "transfer_in" ? (
            <div className="grid gap-6 md:grid-cols-2">
              <div className="space-y-4">
                <div className="grid gap-2">
                  <Label>Date*</Label>
                  <Input type="date" value={tIn.date} onChange={(e) => setTIn({ ...tIn, date: e.target.value })} />
                </div>
                <div className="grid gap-2">
                  <Label>From Account*</Label>
                  <SelectNative value={tIn.fromBankAccountId} onChange={(e) => setTIn({ ...tIn, fromBankAccountId: e.target.value })}>
                    <option value="">Select an account</option>
                    {otherBankingAccounts.map((b: any) => (
                      <option key={b.id} value={b.account.id}>
                        {b.kind} - {b.account.code} {b.account.name}
                      </option>
                    ))}
                  </SelectNative>
                </div>
                <div className="grid gap-2">
                  <Label>Amount*</Label>
                  <div className="flex gap-2">
                    <SelectNative className="w-[100px]" disabled>
                      <option>MMK</option>
                    </SelectNative>
                    <Input
                      type="number"
                      inputMode="numeric"
                      step="1"
                      min="1"
                      value={tIn.amount}
                      onChange={(e) => setTIn({ ...tIn, amount: e.target.value })}
                      placeholder="0"
                    />
                  </div>
                </div>
              </div>
              <div className="space-y-4">
                <div className="grid gap-2">
                  <Label>Reference#</Label>
                  <Input value={tIn.reference} onChange={(e) => setTIn({ ...tIn, reference: e.target.value })} placeholder="optional" />
                </div>
                <div className="grid gap-2">
                  <Label>Description</Label>
                  <Textarea
                    value={tIn.description}
                    onChange={(e) => setTIn({ ...tIn, description: e.target.value })}
                    placeholder="optional"
                    className="min-h-[110px]"
                  />
                </div>
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={close} disabled={loading}>
              Cancel
            </Button>
            <Button loading={loading} loadingText="Saving..." onClick={submit} disabled={!flow}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}


