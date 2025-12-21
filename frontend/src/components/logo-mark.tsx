"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

type LogoMarkProps = {
  className?: string
  title?: string
}

/**
 * Simple luxury CF mark:
 * - Uses `currentColor` so Tailwind `text-primary` controls the brand color.
 * - Subtle highlight + border for a premium feel without being loud.
 */
export function LogoMark({ className, title = "Cashflow" }: LogoMarkProps) {
  return (
    <svg
      viewBox="0 0 64 64"
      role="img"
      aria-label={title}
      className={cn("text-primary", className)}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="cf_shine" x1="10" y1="8" x2="52" y2="56" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.22" />
          <stop offset="0.45" stopColor="#ffffff" stopOpacity="0.08" />
          <stop offset="1" stopColor="#000000" stopOpacity="0.18" />
        </linearGradient>
        <filter id="cf_shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="1" stdDeviation="1.2" floodColor="#000000" floodOpacity="0.18" />
        </filter>
      </defs>

      {/* Base tile */}
      <rect x="6" y="6" width="52" height="52" rx="14" fill="currentColor" filter="url(#cf_shadow)" />
      {/* Premium border */}
      <rect x="6.75" y="6.75" width="50.5" height="50.5" rx="13.25" fill="none" stroke="#ffffff" strokeOpacity="0.22" />
      {/* Subtle shine */}
      <rect x="6" y="6" width="52" height="52" rx="14" fill="url(#cf_shine)" />

      {/* Monogram */}
      <text
        x="32"
        y="40.5"
        textAnchor="middle"
        fontFamily="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial"
        fontSize="26"
        fontWeight="800"
        letterSpacing="-1.5"
        fill="#ffffff"
      >
        CF
      </text>
    </svg>
  )
}


