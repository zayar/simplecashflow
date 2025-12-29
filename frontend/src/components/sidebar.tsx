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
  Percent,
  CreditCard,
} from "lucide-react"

import { useAuth } from "@/contexts/auth-context"
import { cn } from "@/lib/utils"
import { buttonVariants } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { LogoMark } from "@/components/logo-mark"

type NavItem = {
  href: string
  label: string
  icon: React.ComponentType<{ className?: string }>
}

const navGroups: { label: string; items: NavItem[] }[] = [
  // Home
  { label: "Home", items: [{ href: "/dashboard", label: "Dashboard", icon: LayoutDashboard }] },

  // Top-level items
  { label: "", items: [{ href: "/items", label: "Items", icon: Package }] },

  // Sales
  {
    label: "Sales",
    items: [
      { href: "/customers", label: "Customers", icon: Users },
      { href: "/invoices", label: "Invoices", icon: FileText },
      { href: "/credit-notes", label: "Credit Notes", icon: FileText },
      { href: "/sales/payments", label: "Payments", icon: CreditCard },
    ],
  },

  // Purchases
  {
    label: "Purchases",
    items: [
      { href: "/vendors", label: "Vendors", icon: Truck },
      { href: "/expenses", label: "Expenses", icon: ReceiptText },
      { href: "/purchase-bills", label: "Purchase Bills", icon: ReceiptText },
      { href: "/vendor-credits", label: "Vendor Credits", icon: ReceiptText },
      { href: "/purchases/payments", label: "Payments", icon: CreditCard },
    ],
  },

  // Inventory
  {
    label: "Inventory",
    items: [
      { href: "/inventory/summary", label: "Inventory Summary", icon: Package },
      { href: "/inventory/opening-balance", label: "Opening Balance", icon: Package },
      { href: "/inventory/adjustments", label: "Adjust Stock", icon: Package },
      { href: "/inventory/locations", label: "Locations", icon: Package },
    ],
  },

  // Banking
  { label: "", items: [{ href: "/banking", label: "Banking", icon: Landmark }] },

  // Accounting
  {
    label: "Accounting",
    items: [
      { href: "/journal", label: "Journal", icon: BookOpen },
      { href: "/accounts", label: "Accounts", icon: Calculator },
      { href: "/taxes", label: "Taxes", icon: Percent },
    ],
  },

  // Reports
  { label: "Reports", items: [{ href: "/reports", label: "Reports", icon: BarChart }] },

  // Company Profile
  { label: "", items: [{ href: "/settings", label: "Company Profile", icon: Settings }] },
]

export function Sidebar({ collapsed = false }: { collapsed?: boolean } = {}) {
  const pathname = usePathname()
  const { user } = useAuth()

  if (!user) return null

  return (
    <div className="flex h-full flex-col">
      <Link
        href="/dashboard"
        title="Dashboard"
        className={cn(
          "flex h-14 items-center gap-2",
          collapsed ? "justify-center px-2" : "px-4"
        )}
      >
        <LogoMark className="h-9 w-9" title="Cashflow" />
        {!collapsed ? (
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold tracking-tight">
              Cashflow
            </div>
            <div className="truncate text-xs text-muted-foreground">
              Company #{user.companyId}
            </div>
          </div>
        ) : (
          <span className="sr-only">Cashflow</span>
        )}
      </Link>

      <Separator />

      <div className={cn("flex-1 overflow-auto py-3", collapsed ? "px-1" : "px-2")}>
        <nav className="space-y-4">
          {navGroups.map((group) => (
            <div key={group.label} className="space-y-1">
              {!collapsed && group.label ? (
                <div className="px-2 text-xs font-medium text-muted-foreground">
                  {group.label}
                </div>
              ) : null}
              <div className="space-y-1">
                {group.items.map((item) => {
                  const isActive =
                    pathname === item.href || pathname.startsWith(item.href + "/")

                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      title={item.label}
                      className={cn(
                        buttonVariants({
                          variant: isActive ? "secondary" : "ghost",
                          size: "sm",
                        }),
                        collapsed ? "w-full justify-center px-2" : "w-full justify-start gap-2",
                        isActive && "font-medium"
                      )}
                    >
                      <span className={cn("inline-flex items-center", collapsed ? "gap-0" : "gap-2")}>
                        <item.icon className="h-4 w-4" />
                        {collapsed ? <span className="sr-only">{item.label}</span> : item.label}
                      </span>
                    </Link>
                  )
                })}
              </div>
            </div>
          ))}
        </nav>
      </div>

      <Separator />

      <div className="p-3">
        {!collapsed ? (
          <div className="px-2 py-1">
            <div className="truncate text-sm font-medium">
              {user.name || "Account"}
            </div>
            <div className="truncate text-xs text-muted-foreground">{user.email}</div>
          </div>
        ) : (
          <div className="flex justify-center px-2 py-1">
            <div
              className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-xs font-semibold"
              title={user.email}
            >
              {(user.name || user.email || "U").slice(0, 1).toUpperCase()}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
