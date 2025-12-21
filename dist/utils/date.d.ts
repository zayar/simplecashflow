export declare function isoNow(): string;
export declare function normalizeToDay(date: Date): Date;
/**
 * Parses an input date string safely.
 *
 * Supports:
 * - "YYYY-MM-DD" (treat as a date-only input; interpreted as UTC midnight)
 * - Any ISO datetime string supported by JS Date
 *
 * Returns null if invalid.
 */
export declare function parseDateInput(value?: string | null): Date | null;
//# sourceMappingURL=date.d.ts.map