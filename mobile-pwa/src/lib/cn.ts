export type ClassValue = string | number | null | false | undefined | ClassValue[] | Record<string, any>;

function toClassName(value: ClassValue): string {
  if (!value) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(toClassName).filter(Boolean).join(' ');
  if (typeof value === 'object') {
    return Object.entries(value)
      .filter(([, v]) => Boolean(v))
      .map(([k]) => k)
      .join(' ');
  }
  return '';
}

// Minimal cn() helper (shadcn-style) without external deps.
export function cn(...inputs: ClassValue[]): string {
  return inputs.map(toClassName).filter(Boolean).join(' ');
}


