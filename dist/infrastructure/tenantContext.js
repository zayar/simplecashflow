import { AsyncLocalStorage } from 'node:async_hooks';
const als = new AsyncLocalStorage();
export function runWithTenant(companyId, fn) {
    return als.run({ companyId }, fn);
}
// Convenience wrapper for async flows (worker/jobs). AsyncLocalStorage already propagates across awaits;
// this helper just improves readability and typing at call sites.
export async function runWithTenantAsync(companyId, fn) {
    return await runWithTenant(companyId, fn);
}
export function getTenantCompanyId() {
    const v = als.getStore()?.companyId;
    return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;
}
//# sourceMappingURL=tenantContext.js.map