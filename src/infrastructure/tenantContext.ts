import { AsyncLocalStorage } from 'node:async_hooks';

type TenantStore = { companyId: number };

const als = new AsyncLocalStorage<TenantStore>();

export function runWithTenant<T>(companyId: number, fn: () => T): T {
  return als.run({ companyId }, fn);
}

// Convenience wrapper for async flows (worker/jobs). AsyncLocalStorage already propagates across awaits;
// this helper just improves readability and typing at call sites.
export async function runWithTenantAsync<T>(companyId: number, fn: () => Promise<T>): Promise<T> {
  return await runWithTenant(companyId, fn);
}

export function getTenantCompanyId(): number | null {
  const v = als.getStore()?.companyId;
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;
}


