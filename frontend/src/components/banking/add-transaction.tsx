/* eslint-disable react-hooks/exhaustive-deps */
"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Check, ChevronDown, Plus, Search } from "lucide-react"

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

function InlineAccountPicker({
  accounts,
  value,
  onChange,
  disabled,
}: {
  accounts: any[]
  value: string
  onChange: (nextId: string) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState("")

  const selected = useMemo(() => {
    const id = Number(value || 0)
    if (!id) return null
    return (accounts ?? []).find((a: any) => Number(a?.id) === id) ?? null
  }, [accounts, value])

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase()
    const rows = Array.isArray(accounts) ? accounts : []
    if (!term) return rows
    return rows.filter((a: any) => {
      const hay = `${a?.code ?? ""} ${a?.name ?? ""}`.toLowerCase()
      return hay.includes(term)
    })
  }, [accounts, q])

  return (
    <div className="relative">
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        className="w-full justify-between font-normal"
        onClick={() => setOpen((v) => !v)}
      >
        <span className={selected ? "text-foreground" : "text-muted-foreground"}>
          {selected ? `${selected.code ? `${selected.code} - ` : ""}${selected.name}` : "Select an account"}
        </span>
        <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-70" />
      </Button>

      {open ? (
        <div className="absolute left-0 right-0 top-[calc(100%+8px)] z-50 rounded-lg border bg-background shadow-lg">
          <div className="p-2 border-b">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input className="pl-8" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          </div>
          <div className="max-h-72 overflow-auto p-2">
            {filtered.length === 0 ? (
              <div className="px-2 py-3 text-sm text-muted-foreground">No accounts</div>
            ) : (
              <div className="space-y-1">
                {filtered.map((a: any) => {
                  const idStr = String(a.id)
                  const isSelected = idStr === String(value)
                  return (
                    <button
                      key={a.id}
                      type="button"
                      className={
                        "w-full rounded-md px-3 py-2 text-left text-sm hover:bg-muted flex items-center justify-between " +
                        (isSelected ? "bg-muted" : "")
                      }
                      onClick={() => {
                        onChange(idStr)
                        setOpen(false)
                        setQ("")
                      }}
                    >
                      <span className="truncate">{a.code ? `${a.code} - ` : ""}{a.name}</span>
                      {isSelected ? <Check className="h-4 w-4 text-primary" /> : null}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}

type Flow =
  | "expense"
  | "transfer_out"
  | "vendor_payment"
  | "customer_payment"
  | "sales_no_invoice"
  | "other_income"
  | "other_in"
  | "transfer_in"
  | "other_out"

type PresetKey =
  | "loan_received"
  | "owner_capital"
  | "customer_advance"
  | "loan_interest"
  | "loan_principal"
  | "supplier_advance"
  | "owner_drawings"

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
  const [preset, setPreset] = useState<PresetKey | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingAccounts, setLoadingAccounts] = useState(false)

  const paymentMode = useMemo(() => bankKindToPaymentMode(bankKind), [bankKind])

  // Shared lookups
  const [bankingAccounts, setBankingAccounts] = useState<any[]>([])
  const [expenseAccounts, setExpenseAccounts] = useState<any[]>([])
  const [incomeAccounts, setIncomeAccounts] = useState<any[]>([])
  const [allAccounts, setAllAccounts] = useState<any[]>([])
  const [vendors, setVendors] = useState<any[]>([])
  const [customers, setCustomers] = useState<any[]>([])
  const [warehouses, setWarehouses] = useState<any[]>([])
  const [warehouseId, setWarehouseId] = useState("")
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

  // Money In: Other (pick any COA account - e.g., loan, capital)
  const [otherIn, setOtherIn] = useState({
    date: "",
    amount: "",
    accountId: "", // any COA accountId
    reference: "",
    description: "",
  })
  const [customerAdvanceCustomerId, setCustomerAdvanceCustomerId] = useState("")

  // Money In: Transfer from another account
  const [tIn, setTIn] = useState({
    date: "",
    amount: "",
    fromBankAccountId: "", // COA accountId for source
    reference: "",
    description: "",
  })

  // Money Out: Other (pick any COA account - e.g., loan repayment principal, supplier advance)
  const [otherOut, setOtherOut] = useState({
    date: "",
    amount: "",
    accountId: "", // any COA accountId
    reference: "",
    description: "",
  })
  const [supplierAdvanceVendorId, setSupplierAdvanceVendorId] = useState("")

  const resetForFlow = (f: Flow) => {
    const today = todayInTimeZone(timeZone)
    setLoading(false)
    setSelectedInvoice(null)
    setPreset(null)
    setWarehouseId("")
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
    } else if (f === "other_in") {
      setOtherIn({ date: today, amount: "", accountId: "", reference: "", description: "" })
      setCustomerAdvanceCustomerId("")
    } else if (f === "transfer_in") {
      setTIn({ date: today, amount: "", fromBankAccountId: "", reference: "", description: "" })
    } else if (f === "other_out") {
      setOtherOut({ date: today, amount: "", accountId: "", reference: "", description: "" })
      setSupplierAdvanceVendorId("")
    }
  }

  const openFlow = (f: Flow) => {
    setFlow(f)
    resetForFlow(f)
    setOpen(true)
  }

  const openPreset = (p: PresetKey) => {
    // Presets are implemented as "Other (Money In/Out)" with auto-picked COA account.
    const presetToFlow: Record<PresetKey, Flow> = {
      loan_received: "other_in",
      owner_capital: "other_in",
      customer_advance: "other_in",
      loan_interest: "other_out",
      loan_principal: "other_out",
      supplier_advance: "other_out",
      owner_drawings: "other_out",
    }
    const f = presetToFlow[p]
    setFlow(f)
    resetForFlow(f)
    setPreset(p)
    setOpen(true)
  }

  // Load Chart of Accounts once per company (so Account Picker is never "stuck" disabled).
  useEffect(() => {
    if (!companyId) return
    setLoadingAccounts(true)
    fetchApi(`/companies/${companyId}/accounts`)
      .then((all) => {
        const rows = Array.isArray(all) ? all : []
        const active = rows.filter((a: any) => a.isActive !== false)
        setAllAccounts(active)
        setExpenseAccounts(rows.filter((a: any) => a.type === "EXPENSE"))
        setIncomeAccounts(rows.filter((a: any) => a.type === "INCOME"))
      })
      .catch((e) => {
        console.error(e)
        setAllAccounts([])
        setExpenseAccounts([])
        setIncomeAccounts([])
      })
      .finally(() => setLoadingAccounts(false))
  }, [companyId])

  // Load banking accounts only when dialog is used (needed for transfers).
  useEffect(() => {
    if (!open) return
    fetchApi(`/companies/${companyId}/banking-accounts`).then(setBankingAccounts).catch(console.error)
  }, [open, companyId])

  // Warehouses (Branch) list for tagging transactions.
  useEffect(() => {
    if (!open) return
    fetchApi(`/companies/${companyId}/warehouses`).then(setWarehouses).catch(console.error)
  }, [open, companyId])

  // Flow-specific lookups
  useEffect(() => {
    if (!open || !flow) return
    if (flow === "expense") {
      fetchApi(`/companies/${companyId}/vendors`).then(setVendors).catch(console.error)
    }
    if (flow === "other_out" && preset === "supplier_advance") {
      fetchApi(`/companies/${companyId}/vendors`).then(setVendors).catch(console.error)
    }
    if (flow === "other_in" && preset === "customer_advance") {
      fetchApi(`/companies/${companyId}/customers`).then(setCustomers).catch(console.error)
    }
    if (flow === "vendor_payment") {
      fetchApi(`/companies/${companyId}/purchase-bills`).then(setPurchaseBills).catch(console.error)
    }
    if (flow === "customer_payment") {
      fetchApi(`/companies/${companyId}/invoices`).then(setInvoices).catch(console.error)
    }
  }, [open, flow, companyId, preset])

  const selectedWarehouse = useMemo(() => {
    if (!warehouseId) return null
    return (Array.isArray(warehouses) ? warehouses : []).find((w: any) => String(w.id) === String(warehouseId)) ?? null
  }, [warehouses, warehouseId])

  const selectedCustomerAdvanceCustomer = useMemo(() => {
    if (!customerAdvanceCustomerId) return null
    return (Array.isArray(customers) ? customers : []).find((c: any) => String(c.id) === String(customerAdvanceCustomerId)) ?? null
  }, [customers, customerAdvanceCustomerId])

  const selectedSupplier = useMemo(() => {
    if (!supplierAdvanceVendorId) return null
    return (Array.isArray(vendors) ? vendors : []).find((v: any) => String(v.id) === String(supplierAdvanceVendorId)) ?? null
  }, [vendors, supplierAdvanceVendorId])

  const decorateDescription = useCallback(
    (desc: string) => {
      const base = String(desc ?? "").trim()
      const whName = String(selectedWarehouse?.name ?? "").trim()
      if (!whName) return base
      return `Branch: ${whName} — ${base}`.trim()
    },
    [selectedWarehouse]
  )

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

  const bankCoaIdSet = useMemo(() => {
    return new Set((bankingAccounts ?? []).map((b: any) => Number(b?.account?.id)).filter((x: any) => Number.isFinite(x)))
  }, [bankingAccounts])

  const selectableCoaAccounts = useMemo(() => {
    const rows = Array.isArray(allAccounts) ? allAccounts : []
    return rows.filter((a: any) => {
      const id = Number(a?.id)
      if (!Number.isFinite(id)) return false
      if (id === bankAccountCoaId) return false
      if (bankCoaIdSet.has(id)) return false // bank/cash accounts must use Transfer flows
      return a.isActive !== false
    })
  }, [allAccounts, bankAccountCoaId, bankCoaIdSet])

  const resolvePresetAccountId = useCallback(
    (p: PresetKey): number | null => {
      const rows = Array.isArray(allAccounts) ? allAccounts : []
      const norm = (s: any) => String(s ?? "").trim().toLowerCase()
      const byContains = (acc: any, terms: string[]) => {
        const hay = `${norm(acc?.code)} ${norm(acc?.name)}`
        return terms.every((t) => hay.includes(t))
      }
      const pick = (pred: (a: any) => boolean) => {
        const found = rows.find((a: any) => pred(a) && Number(a?.id) && Number(a.id) !== bankAccountCoaId && !bankCoaIdSet.has(Number(a.id)))
        return found ? Number(found.id) : null
      }

      switch (p) {
        case "loan_received":
          return (
            pick((a) => a.type === "LIABILITY" && byContains(a, ["loan"])) ??
            pick((a) => a.type === "LIABILITY" && byContains(a, ["payable"])) ??
            null
          )
        case "owner_capital":
          return (
            pick((a) => a.type === "EQUITY" && (byContains(a, ["capital"]) || byContains(a, ["owner"]))) ??
            pick((a) => a.type === "EQUITY") ??
            null
          )
        case "customer_advance":
          return (
            pick(
              (a) =>
                a.type === "LIABILITY" &&
                (byContains(a, ["customer"]) ||
                  byContains(a, ["advance"]) ||
                  byContains(a, ["deposit"]) ||
                  byContains(a, ["deferred"]) ||
                  byContains(a, ["unearned"]))
            ) ??
            pick((a) => a.type === "LIABILITY" && (byContains(a, ["advance"]) || byContains(a, ["deposit"]) || byContains(a, ["unearned"]))) ??
            null
          )
        case "loan_interest":
          return pick((a) => a.type === "EXPENSE" && byContains(a, ["interest"])) ?? null
        case "loan_principal":
          return pick((a) => a.type === "LIABILITY" && byContains(a, ["loan"])) ?? null
        case "supplier_advance":
          return (
            pick((a) => a.type === "ASSET" && (byContains(a, ["advance"]) || byContains(a, ["prepayment"]) || byContains(a, ["prepaid"]))) ??
            null
          )
        case "owner_drawings":
          return pick((a) => a.type === "EQUITY" && (byContains(a, ["draw"]) || byContains(a, ["drawing"]))) ?? null
        default:
          return null
      }
    },
    [allAccounts, bankAccountCoaId, bankCoaIdSet]
  )

  // Apply preset once accounts are loaded (best-effort).
  useEffect(() => {
    if (!open || !flow || !preset) return
    if (!allAccounts.length) return
    const accountId = resolvePresetAccountId(preset)
    if (flow === "other_in") {
      setOtherIn((prev) => {
        if (prev.accountId) return prev
        return {
          ...prev,
          accountId: accountId ? String(accountId) : "",
          description:
            prev.description ||
            (preset === "loan_received"
              ? "Loan received"
              : preset === "owner_capital"
                ? "Owner capital"
                : preset === "customer_advance"
                  ? "Customer advance"
                  : "Money in"),
        }
      })
    }
    if (flow === "other_out") {
      setOtherOut((prev) => {
        if (prev.accountId) return prev
        const desc =
          preset === "loan_interest"
            ? "Loan interest"
            : preset === "loan_principal"
              ? "Loan repayment (principal)"
              : preset === "supplier_advance"
                ? "Supplier advance"
                : preset === "owner_drawings"
                  ? "Owner drawings"
                  : "Money out"
        return { ...prev, accountId: accountId ? String(accountId) : "", description: prev.description || desc }
      })
    }
  }, [open, flow, preset, allAccounts.length, resolvePresetAccountId])

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
      const whId = warehouseId ? Number(warehouseId) : null

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
        description = decorateDescription(description)

        await fetchApi(`/companies/${companyId}/journal-entries`, {
          method: "POST",
          body: JSON.stringify({
            date: tOut.date,
            description,
            warehouseId: whId || undefined,
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
        description = decorateDescription(description)

        await fetchApi(`/companies/${companyId}/journal-entries`, {
          method: "POST",
          body: JSON.stringify({
            date: swi.date,
            description,
            warehouseId: whId || undefined,
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
        description = decorateDescription(description)

        await fetchApi(`/companies/${companyId}/journal-entries`, {
          method: "POST",
          body: JSON.stringify({
            date: oi.date,
            description,
            warehouseId: whId || undefined,
            lines: [
              { accountId: bankAccountCoaId, debit: amount, credit: 0 },
              { accountId: incomeAccountId, debit: 0, credit: amount },
            ],
          }),
        })
      }

      if (flow === "other_in") {
        const amount = toNumber(otherIn.amount)
        if (!amount || amount <= 0) throw new Error("Amount must be > 0")
        if (!otherIn.accountId) throw new Error("Please select an account")
        const accountId = Number(otherIn.accountId)
        if (accountId === bankAccountCoaId) throw new Error("Account must be different from the bank account")
        if (bankCoaIdSet.has(accountId)) throw new Error("Use Transfer From Another Account for bank-to-bank moves")

        let description = String(otherIn.description ?? "")
        if (otherIn.reference) description = `Ref: ${otherIn.reference} - ${description}`
        if (!description.trim()) description = preset === "customer_advance" ? "Customer advance" : "Money in"

        if (preset === "customer_advance") {
          if (!warehouseId) throw new Error("Please select a branch (warehouse)")
          if (!customerAdvanceCustomerId) throw new Error("Please select a customer")
          const customerName = String(selectedCustomerAdvanceCustomer?.name ?? "").trim()
          if (customerName) description = `Customer advance • ${customerName} — ${description}`.trim()
        }
        description = decorateDescription(description)

        await fetchApi(`/companies/${companyId}/journal-entries`, {
          method: "POST",
          body: JSON.stringify({
            date: otherIn.date,
            description,
            warehouseId: whId || undefined,
            lines: [
              { accountId: bankAccountCoaId, debit: amount, credit: 0 },
              { accountId, debit: 0, credit: amount },
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
        description = decorateDescription(description)

        await fetchApi(`/companies/${companyId}/journal-entries`, {
          method: "POST",
          body: JSON.stringify({
            date: tIn.date,
            description,
            warehouseId: whId || undefined,
            lines: [
              { accountId: bankAccountCoaId, debit: amount, credit: 0 },
              { accountId: fromAccountId, debit: 0, credit: amount },
            ],
          }),
        })
      }

      if (flow === "other_out") {
        const amount = toNumber(otherOut.amount)
        if (!amount || amount <= 0) throw new Error("Amount must be > 0")
        if (!otherOut.accountId) throw new Error("Please select an account")
        const accountId = Number(otherOut.accountId)
        if (accountId === bankAccountCoaId) throw new Error("Account must be different from the bank account")
        if (bankCoaIdSet.has(accountId)) throw new Error("Use Transfer to Another Account for bank-to-bank moves")

        let description = String(otherOut.description ?? "")
        if (otherOut.reference) description = `Ref: ${otherOut.reference} - ${description}`
        if (!description.trim()) description = preset === "supplier_advance" ? "Supplier advance" : "Money out"

        if (preset === "supplier_advance") {
          if (!warehouseId) throw new Error("Please select a branch (warehouse)")
          if (!supplierAdvanceVendorId) throw new Error("Please select a supplier")
          const supplierName = String(selectedSupplier?.name ?? "").trim()
          if (supplierName) {
            // Make the supplier visible in transaction list and journal entry description.
            description = `Supplier advance • ${supplierName} — ${description}`.trim()
          }
        }
        description = decorateDescription(description)

        await fetchApi(`/companies/${companyId}/journal-entries`, {
          method: "POST",
          body: JSON.stringify({
            date: otherOut.date,
            description,
            warehouseId: whId || undefined,
            lines: [
              { accountId, debit: amount, credit: 0 },
              { accountId: bankAccountCoaId, debit: 0, credit: amount },
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
      case "other_in":
        return preset === "customer_advance" ? "Customer Advance (Money In)" : "Other (Money In)"
      case "transfer_in":
        return "Transfer From Another Account (Money In)"
      case "other_out":
        return preset === "supplier_advance" ? "Supplier Advance (Money Out)" : "Other (Money Out)"
      default:
        return "Add Transaction"
    }
  }, [flow, preset])

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
      case "other_in":
        return preset === "customer_advance"
          ? `Record a customer advance into ${bankAccountLabel}. Select customer, branch, and the liability account for customer deposits.`
          : `Record a deposit into ${bankAccountLabel} and choose any category account (e.g., loan, capital).`
      case "transfer_in":
        return `Move money into ${bankAccountLabel} from another deposit account.`
      case "other_out":
        return preset === "supplier_advance"
          ? `Record a supplier advance payment from ${bankAccountLabel}. Choose the supplier and the category (advance/prepayment) account.`
          : `Record a withdrawal from ${bankAccountLabel} and choose any category account (e.g., loan payment, advance).`
      default:
        return ""
    }
  }, [flow, preset, bankAccountLabel])

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
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="px-2 py-1 text-xs text-muted-foreground">Common</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => openPreset("loan_interest")}>Loan Interest</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => openPreset("loan_principal")}>Loan Repayment (Principal)</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => openPreset("supplier_advance")}>Supplier Advance</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => openPreset("owner_drawings")}>Owner Drawings</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => openFlow("other_out")}>Other…</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Money In</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-[260px]">
              <DropdownMenuItem onSelect={() => openFlow("customer_payment")}>Customer Payment</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => openFlow("sales_no_invoice")}>Sales Without Invoices</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => openFlow("other_income")}>Other Income</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => openFlow("transfer_in")}>Transfer From Another Account</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="px-2 py-1 text-xs text-muted-foreground">Common</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => openPreset("loan_received")}>Loan Received</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => openPreset("owner_capital")}>Owner Capital</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => openPreset("customer_advance")}>Customer Advance</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => openFlow("other_in")}>Other…</DropdownMenuItem>
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

          {/* Common: Branch/Warehouse tagging */}
          <div className="grid gap-2 md:max-w-[420px]">
            <Label>
              Branch (Warehouse)
              {preset === "supplier_advance" || preset === "customer_advance" ? "*" : ""}
            </Label>
            <SelectNative value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              <option value="">
                {preset === "supplier_advance" || preset === "customer_advance" ? "Select branch" : "Select branch (optional)"}
              </option>
              {(Array.isArray(warehouses) ? warehouses : []).map((w: any) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </SelectNative>
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

          {/* Flow: Other (Money Out) */}
          {flow === "other_out" ? (
            <div className="grid gap-6 md:grid-cols-2">
              <div className="space-y-4">
                <div className="grid gap-2">
                  <Label>Date*</Label>
                  <Input type="date" value={otherOut.date} onChange={(e) => setOtherOut({ ...otherOut, date: e.target.value })} />
                </div>
                <div className="grid gap-2">
                  <Label>Account*</Label>
                  {/* NOTE: AccountPicker uses a portal to document.body which Radix Dialog blocks for pointer events.
                      Use SelectNative here (in-dialog) so selection works reliably. */}
                  <InlineAccountPicker
                    accounts={selectableCoaAccounts}
                    value={otherOut.accountId}
                    onChange={(nextId) => setOtherOut((prev) => ({ ...prev, accountId: nextId }))}
                    disabled={loadingAccounts}
                  />
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
                      value={otherOut.amount}
                      onChange={(e) => setOtherOut({ ...otherOut, amount: e.target.value })}
                      placeholder="0"
                    />
                  </div>
                </div>
              </div>
              <div className="space-y-4">
                {preset === "supplier_advance" ? (
                  <div className="grid gap-2">
                    <Label>Supplier*</Label>
                    <SelectNative value={supplierAdvanceVendorId} onChange={(e) => setSupplierAdvanceVendorId(e.target.value)}>
                      <option value="">Select supplier</option>
                      {(Array.isArray(vendors) ? vendors : []).map((v: any) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                        </option>
                      ))}
                    </SelectNative>
                    <p className="text-xs text-muted-foreground">
                      This is used to label the transaction (for reporting/search). Inventory remains managed by POS.
                    </p>
                  </div>
                ) : null}
                <div className="grid gap-2">
                  <Label>Reference#</Label>
                  <Input value={otherOut.reference} onChange={(e) => setOtherOut({ ...otherOut, reference: e.target.value })} placeholder="optional" />
                </div>
                <div className="grid gap-2">
                  <Label>Description</Label>
                  <Textarea
                    value={otherOut.description}
                    onChange={(e) => setOtherOut({ ...otherOut, description: e.target.value })}
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

          {/* Flow: Other (Money In) */}
          {flow === "other_in" ? (
            <div className="grid gap-6 md:grid-cols-2">
              <div className="space-y-4">
                <div className="grid gap-2">
                  <Label>Date*</Label>
                  <Input type="date" value={otherIn.date} onChange={(e) => setOtherIn({ ...otherIn, date: e.target.value })} />
                </div>
                {preset === "customer_advance" ? (
                  <div className="grid gap-2">
                    <Label>Customer*</Label>
                    <SelectNative value={customerAdvanceCustomerId} onChange={(e) => setCustomerAdvanceCustomerId(e.target.value)}>
                      <option value="">Select customer</option>
                      {(Array.isArray(customers) ? customers : []).map((c: any) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </SelectNative>
                  </div>
                ) : null}
                <div className="grid gap-2">
                  <Label>Account*</Label>
                  <InlineAccountPicker
                    accounts={selectableCoaAccounts}
                    value={otherIn.accountId}
                    onChange={(nextId) => setOtherIn((prev) => ({ ...prev, accountId: nextId }))}
                    disabled={loadingAccounts}
                  />
                  {preset === "customer_advance" ? (
                    <p className="text-xs text-muted-foreground">Pick the liability account for customer advances/deposits.</p>
                  ) : null}
                </div>
                <div className="grid gap-2">
                  <Label>{preset === "customer_advance" ? "Amount Received*" : "Amount*"}</Label>
                  <div className="flex gap-2">
                    <SelectNative className="w-[100px]" disabled>
                      <option>MMK</option>
                    </SelectNative>
                    <Input
                      type="number"
                      inputMode="numeric"
                      step="1"
                      min="1"
                      value={otherIn.amount}
                      onChange={(e) => setOtherIn({ ...otherIn, amount: e.target.value })}
                      placeholder="0"
                    />
                  </div>
                </div>
              </div>
              <div className="space-y-4">
                <div className="grid gap-2">
                  <Label>{preset === "customer_advance" ? "Payment #" : "Reference#"}</Label>
                  <Input value={otherIn.reference} onChange={(e) => setOtherIn({ ...otherIn, reference: e.target.value })} placeholder="optional" />
                </div>
                {preset === "customer_advance" ? (
                  <div className="grid gap-2">
                    <Label>Received Via</Label>
                    <SelectNative disabled value={paymentMode}>
                      <option value="CASH">Cash</option>
                      <option value="BANK">Bank</option>
                      <option value="E_WALLET">E‑wallet</option>
                    </SelectNative>
                  </div>
                ) : null}
                <div className="grid gap-2">
                  <Label>Description</Label>
                  <Textarea
                    value={otherIn.description}
                    onChange={(e) => setOtherIn({ ...otherIn, description: e.target.value })}
                    placeholder={preset === "customer_advance" ? "Max. 500 characters" : "optional"}
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


