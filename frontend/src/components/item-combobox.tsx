"use client"

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import Link from "next/link"
import { Check, ChevronDown, Plus, Search } from "lucide-react"

import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"

export type ItemComboboxItem = {
  id: number
  name: string
  sku?: string | null
  sellingPrice?: any
  costPrice?: any
  trackInventory?: boolean
}

export function ItemCombobox({
  items,
  valueText,
  placeholder,
  onChangeText,
  onSelectItem,
  stockByItemId,
  selectedLocationLabel,
  currencyLabel,
  priceLabel,
  getPrice,
  addNewHref = "/items/new",
  disabled,
}: {
  items: ItemComboboxItem[]
  valueText: string
  placeholder?: string
  onChangeText: (text: string) => void
  onSelectItem: (item: ItemComboboxItem) => void
  stockByItemId?: Record<number, number>
  selectedLocationLabel?: string | null
  currencyLabel?: string | null
  priceLabel?: string
  getPrice?: (item: ItemComboboxItem) => number
  addNewHref?: string
  disabled?: boolean
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState("")
  const [anchor, setAnchor] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null)

  const normalizedText = String(valueText ?? "")

  // Keep search query in sync with typed text when opening.
  useEffect(() => {
    if (!open) return
    setQ(normalizedText)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    function onDown(e: MouseEvent) {
      const t = e.target as any
      if (ref.current?.contains(t)) return
      if (panelRef.current?.contains(t)) return
      {
        setOpen(false)
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [])

  // When open, measure the input and position the floating panel in a portal.
  useLayoutEffect(() => {
    if (!open) {
      setAnchor(null)
      return
    }
    if (typeof window === "undefined") return

    function measure() {
      const root = ref.current
      if (!root) return
      const rect = root.getBoundingClientRect()
      const gap = 8
      const top = rect.bottom + gap
      const maxHeight = Math.max(180, window.innerHeight - top - 12)
      setAnchor({
        left: rect.left,
        top,
        width: rect.width,
        maxHeight,
      })
    }

    measure()
    window.addEventListener("resize", measure)
    // Capture scroll on any scroll container
    window.addEventListener("scroll", measure, true)
    return () => {
      window.removeEventListener("resize", measure)
      window.removeEventListener("scroll", measure, true)
    }
  }, [open])

  const filtered = useMemo(() => {
    const term = String(q ?? "").trim().toLowerCase()
    const rows = Array.isArray(items) ? items : []
    if (!term) return rows.slice(0, 50)
    const hits = rows.filter((it) => {
      const hay = `${String(it?.name ?? "")} ${String(it?.sku ?? "")}`.toLowerCase()
      return hay.includes(term)
    })
    return hits.slice(0, 50)
  }, [items, q])

  const selectedId = useMemo(() => {
    const t = normalizedText.trim().toLowerCase()
    if (!t) return null
    const m = (items ?? []).find((i) => String(i?.name ?? "").trim().toLowerCase() === t)
    return m ? Number(m.id) : null
  }, [items, normalizedText])

  return (
    <div ref={ref} className="relative">
      <div className="flex items-stretch gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            disabled={disabled}
            className="h-12 pl-9 pr-10 text-base"
            placeholder={placeholder ?? "Type or click to select an item…"}
            value={normalizedText}
            onFocus={() => setOpen(true)}
            onClick={() => setOpen(true)}
            onChange={(e) => {
              const next = e.target.value
              onChangeText(next)
              setQ(next)
              setOpen(true)
            }}
          />
          <button
            type="button"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground hover:bg-muted"
            onClick={() => setOpen((v) => !v)}
            disabled={disabled}
            aria-label="Toggle item list"
          >
            <ChevronDown className={cn("h-4 w-4 transition-transform", open ? "rotate-180" : "")} />
          </button>
        </div>
      </div>

      {open && anchor && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={panelRef}
              className="z-[9999] rounded-lg border bg-background shadow-lg"
              style={{
                position: "fixed",
                left: anchor.left,
                top: anchor.top,
                width: anchor.width,
              }}
            >
              <div className="flex items-center justify-between gap-3 border-b p-3">
                <div className="text-xs text-muted-foreground">
                  {selectedLocationLabel ? <span>Stock on hand ({selectedLocationLabel})</span> : <span>Stock on hand</span>}
                </div>
                <div className="text-xs text-muted-foreground">
                  {(() => {
                    const base = String(priceLabel ?? "Price")
                    return currencyLabel ? `${base} (${currencyLabel})` : base
                  })()}
                </div>
              </div>

              <div className="overflow-auto p-2" style={{ maxHeight: anchor.maxHeight }}>
                {filtered.length === 0 ? (
                  <div className="px-2 py-3 text-sm text-muted-foreground">No items</div>
                ) : (
                  <div className="space-y-1">
                    {filtered.map((it) => {
                      const id = Number(it.id)
                      const isSelected = selectedId === id
                      const sku = String(it.sku ?? "").trim()
                      const price = (() => {
                        try {
                          return Number((getPrice ? getPrice(it) : it.sellingPrice) ?? 0)
                        } catch {
                          return Number(it.sellingPrice ?? 0)
                        }
                      })()
                      const stock = stockByItemId ? stockByItemId[id] : undefined
                      const stockLabel =
                        typeof stock === "number" && Number.isFinite(stock)
                          ? stock.toLocaleString(undefined, { maximumFractionDigits: 2 })
                          : "—"

                      return (
                        <button
                          key={id}
                          type="button"
                          className={cn("w-full rounded-md px-3 py-2 text-left text-sm hover:bg-muted", isSelected ? "bg-muted" : "")}
                          onClick={() => {
                            onSelectItem(it)
                            setOpen(false)
                            setQ("")
                          }}
                        >
                          <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <div className="truncate font-medium">{it.name}</div>
                                {isSelected ? <Check className="h-4 w-4 text-primary" /> : null}
                              </div>
                              {sku ? <div className="mt-0.5 text-xs text-muted-foreground">SKU: {sku}</div> : null}
                            </div>
                            <div className="shrink-0 text-right">
                              <div className={cn("text-xs", stockLabel === "—" ? "text-muted-foreground" : "text-emerald-700")}>
                                {stockLabel}
                              </div>
                              <div className="mt-0.5 tabular-nums text-xs text-muted-foreground">
                                {Number.isFinite(price) ? price.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—"}
                              </div>
                            </div>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>

              <div className="border-t p-2">
                <Link href={addNewHref} className="block">
                  <Button type="button" variant="ghost" className="w-full justify-start gap-2">
                    <Plus className="h-4 w-4" />
                    Add New Item
                  </Button>
                </Link>
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  )
}

