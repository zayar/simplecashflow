import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Returns YYYY-MM-DD for a given date as seen in a specific IANA time zone.
 * This is the safest format to use for HTML <input type="date" /> values.
 */
export function formatDateInputInTimeZone(date: Date, timeZone: string) {
  // en-CA outputs ISO-like YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date)
}

export function todayInTimeZone(timeZone: string) {
  return formatDateInputInTimeZone(new Date(), timeZone)
}

function toValidDate(value: Date | string | number | null | undefined): Date | null {
  if (value === null || value === undefined) return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

export function formatDateInTimeZone(
  value: Date | string | number | null | undefined,
  timeZone: string,
  fallback = "—"
) {
  const d = toValidDate(value)
  if (!d) return fallback
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d)
}

export function formatDateTimeInTimeZone(
  value: Date | string | number | null | undefined,
  timeZone: string,
  fallback = "—"
) {
  const d = toValidDate(value)
  if (!d) return fallback
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d)
}

