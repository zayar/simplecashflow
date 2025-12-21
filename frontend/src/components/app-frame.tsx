"use client"

import * as React from "react"
import { usePathname, useRouter } from "next/navigation"
import Link from "next/link"
import { Menu, LogOut } from "lucide-react"

import { useAuth } from "@/contexts/auth-context"
import { cn } from "@/lib/utils"
import { Sidebar } from "@/components/sidebar"
import { buttonVariants } from "@/components/ui/button"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"

function pageTitleFromPath(pathname: string) {
  if (pathname === "/") return "Dashboard"
  const map: Record<string, string> = {
    "/invoices": "Invoices",
    "/credit-notes": "Credit Notes",
    "/expenses": "Expenses",
    "/customers": "Customers",
    "/vendors": "Vendors",
    "/items": "Items",
    "/banking": "Banking",
    "/journal": "Journal",
    "/accounts": "Chart of Accounts",
    "/settings": "Company Profile",
    "/reports": "Reports",
    "/inventory": "Inventory",
    "/purchase-bills": "Purchase Bills",
  }
  // Handle nested pages
  for (const [prefix, title] of Object.entries(map)) {
    if (pathname === prefix || pathname.startsWith(prefix + "/")) return title
  }
  return ""
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const { user, isLoading } = useAuth()

  React.useEffect(() => {
    if (isLoading) return
    const isAuthRoute = pathname === "/login" || pathname === "/register"
    if (!user && !isAuthRoute) router.push("/login")
  }, [isLoading, user, pathname, router])

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <div className="mx-auto max-w-7xl px-6 py-10">
          <div className="space-y-6">
            <Skeleton className="h-8 w-48" />
            <div className="grid gap-4 md:grid-cols-3">
              <Skeleton className="h-28" />
              <Skeleton className="h-28" />
              <Skeleton className="h-28" />
            </div>
            <Skeleton className="h-72" />
          </div>
        </div>
      </div>
    )
  }

  return <>{children}</>
}

export function AppFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const { user, logout } = useAuth()

  const isAuthRoute = pathname === "/login" || pathname === "/register"
  if (isAuthRoute) {
    return <div className="min-h-screen bg-muted/30">{children}</div>
  }

  const title = pageTitleFromPath(pathname)

  return (
    <AuthGate>
      <div className="min-h-screen bg-background">
        <div className="flex min-h-screen">
          {/* Desktop sidebar */}
          <aside className="hidden w-64 shrink-0 border-r bg-background lg:block">
            <Sidebar />
          </aside>

          <div className="flex min-w-0 flex-1 flex-col">
            {/* Header */}
            <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/60 lg:px-6">
              {/* Mobile menu */}
              <div className="lg:hidden">
                <Sheet>
                  <SheetTrigger
                    aria-label="Open menu"
                    className={buttonVariants({ variant: "ghost", size: "icon" })}
                    type="button"
                  >
                    <Menu className="h-5 w-5" />
                  </SheetTrigger>
                  <SheetContent side="left" className="p-0">
                    <Sidebar />
                  </SheetContent>
                </Sheet>
              </div>

              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-muted-foreground">
                  {title}
                </div>
                <div className="truncate text-base font-semibold tracking-tight">
                  {title || "Cashflow"}
                </div>
              </div>

              {user ? (
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger
                    className={cn(
                      buttonVariants({ variant: "ghost", size: "sm" }),
                      "h-9 gap-2 px-2"
                    )}
                    type="button"
                  >
                    <Avatar className="h-7 w-7">
                      <AvatarFallback>
                        {(user.name || user.email || "U")
                          .slice(0, 1)
                          .toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <span className="hidden max-w-[180px] truncate text-sm font-medium md:inline">
                      {user.name || user.email}
                    </span>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuLabel className="space-y-0.5">
                      <div className="text-sm font-medium leading-none">
                        {user.name || "Account"}
                      </div>
                      <div className="text-xs font-normal text-muted-foreground">
                        {user.email}
                      </div>
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem asChild>
                      <Link href="/reports">
                        <span>Reports</span>
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className={cn("text-destructive focus:text-destructive")}
                      onClick={logout}
                    >
                      <LogOut className="mr-2 h-4 w-4" />
                      Logout
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </header>

            {/* Main */}
            <main className="flex-1">
              <div className="mx-auto w-full max-w-7xl px-4 py-6 lg:px-6">
                {children}
              </div>
            </main>

            {/* Footer */}
            <footer className="border-t py-4">
              <div className="mx-auto max-w-7xl px-4 text-xs text-muted-foreground lg:px-6">
                {user ? `Signed in as ${user.email}` : null}
              </div>
            </footer>
          </div>
        </div>
      </div>
    </AuthGate>
  )
}

