export function isoNow(): string {
  return new Date().toISOString();
}

export function normalizeToDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

