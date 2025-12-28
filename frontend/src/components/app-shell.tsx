"use client"

import * as React from "react"
import { usePathname } from "next/navigation"

import { AppFrame } from "@/components/app-frame"

const MARKETING_PATHS = new Set(["/"])

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const isMarketing = pathname ? MARKETING_PATHS.has(pathname) : false

  if (isMarketing) {
    return <div className="min-h-screen bg-background">{children}</div>
  }

  return <AppFrame>{children}</AppFrame>
}

