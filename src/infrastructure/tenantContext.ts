import { AsyncLocalStorage } from 'node:async_hooks';

type TenantStore = { companyId: number };

const als = new AsyncLocalStorage<TenantStore>();

export function runWithTenant<T>(companyId: number, fn: () => T): T {
  return als.run({ companyId }, fn);
}

export function getTenantCompanyId(): number | null {
  const v = als.getStore()?.companyId;
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;
}


