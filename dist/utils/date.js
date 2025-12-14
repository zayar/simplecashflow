export function isoNow() {
    return new Date().toISOString();
}
export function normalizeToDay(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
}
//# sourceMappingURL=date.js.map