"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  LayoutDashboard,
  Users,
  Package,
  FileText,
  BookOpen,
  Landmark,
  BarChart,
  Calculator,
  ReceiptText,
  Truck,
  Settings,
} from "lucide-react"

import { useAuth } from "@/contexts/auth-context"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"

type NavItem = {
  href: string
  label: string
  icon: React.ComponentType<{ className?: string }>
}

const navGroups: { label: string; items: NavItem[] }[] = [
  {
    label: "Overview",
    items: [{ href: "/", label: "Dashboard", icon: LayoutDashboard }],
  },
  {
    label: "Money",
    items: [
      { href: "/invoices", label: "Invoices", icon: FileText },
      { href: "/expenses", label: "Expenses", icon: ReceiptText },
      { href: "/purchase-bills", label: "Purchase Bills", icon: ReceiptText },
      { href: "/banking", label: "Banking", icon: Landmark },
    ],
  },
  {
    label: "Accounting",
    items: [
      { href: "/journal", label: "Journal", icon: BookOpen },
      { href: "/accounts", label: "Accounts", icon: Calculator },
      { href: "/settings", label: "Company Profile", icon: Settings },
    ],
  },
  {
    label: "Reports",
    items: [{ href: "/reports", label: "Reports", icon: BarChart }],
  },
  {
    label: "Inventory",
    items: [
      { href: "/inventory/summary", label: "Inventory Summary", icon: Package },
      { href: "/inventory/opening-balance", label: "Opening Balance", icon: Package },
      { href: "/inventory/adjustments", label: "Adjust Stock", icon: Package },
      { href: "/inventory/warehouses", label: "Warehouses", icon: Package },
    ],
  },
  {
    label: "Contacts",
    items: [
      { href: "/customers", label: "Customers", icon: Users },
      { href: "/vendors", label: "Vendors", icon: Truck },
      { href: "/items", label: "Items", icon: Package },
    ],
  },
]

export function Sidebar() {
  const pathname = usePathname()
  const { user } = useAuth()

  if (!user) return null

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center gap-2 px-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg border bg-background text-sm font-semibold">
          C
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold tracking-tight">
            Cashflow
          </div>
          <div className="truncate text-xs text-muted-foreground">
            Company #{user.companyId}
          </div>
        </div>
      </div>

      <Separator />

      <div className="flex-1 overflow-auto px-2 py-3">
        <nav className="space-y-4">
          {navGroups.map((group) => (
            <div key={group.label} className="space-y-1">
              <div className="px-2 text-xs font-medium text-muted-foreground">
                {group.label}
              </div>
              <div className="space-y-1">
                {group.items.map((item) => {
                  const isActive =
                    item.href === "/"
                      ? pathname === "/"
                      : pathname === item.href || pathname.startsWith(item.href + "/")

                  return (
                    <Button
                      key={item.href}
                      asChild
                      variant={isActive ? "secondary" : "ghost"}
                      className={cn(
                        "w-full justify-start gap-2",
                        isActive && "font-medium"
                      )}
                    >
                      <Link href={item.href}>
                        <item.icon className="h-4 w-4" />
                        {item.label}
                      </Link>
                    </Button>
                  )
                })}
              </div>
            </div>
          ))}
        </nav>
      </div>

      <Separator />

      <div className="p-3">
        <div className="px-2 py-1">
          <div className="truncate text-sm font-medium">
            {user.name || "Account"}
          </div>
          <div className="truncate text-xs text-muted-foreground">{user.email}</div>
        </div>
      </div>
    </div>
  )
}
