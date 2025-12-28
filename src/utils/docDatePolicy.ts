/**
 * Document date policy helpers.
 *
 * We compare by *calendar day* in a given time zone (not by timestamp) because
 * accounting documents are generally posted by business day.
 */

function safeTimeZoneOrUtc(input: unknown): string {
  const tz = typeof input === 'string' ? input.trim() : '';
  if (!tz) return 'UTC';
  try {
    // Throws RangeError for invalid time zone ids.
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date(0));
    return tz;
  } catch {
    return 'UTC';
  }
}

function ymdInTimeZone(date: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function isFutureBusinessDate(args: { date: Date; now?: Date; timeZone?: string | null }): boolean {
  const tz = safeTimeZoneOrUtc(args.timeZone ?? null);
  const now = args.now ?? new Date();
  return ymdInTimeZone(args.date, tz) > ymdInTimeZone(now, tz);
}


