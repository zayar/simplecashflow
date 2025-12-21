export function isoNow() {
    return new Date().toISOString();
}
export function normalizeToDay(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
}
/**
 * Parses an input date string safely.
 *
 * Supports:
 * - "YYYY-MM-DD" (treat as a date-only input; interpreted as UTC midnight)
 * - Any ISO datetime string supported by JS Date
 *
 * Returns null if invalid.
 */
export function parseDateInput(value) {
    if (!value)
        return null;
    const v = String(value).trim();
    if (!v)
        return null;
    // Date-only input from <input type="date" />.
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        const d = new Date(`${v}T00:00:00.000Z`);
        return Number.isNaN(d.getTime()) ? null : d;
    }
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
}
//# sourceMappingURL=date.js.map