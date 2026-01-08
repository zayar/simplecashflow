export declare function runWithTenant<T>(companyId: number, fn: () => T): T;
export declare function runWithTenantAsync<T>(companyId: number, fn: () => Promise<T>): Promise<T>;
export declare function getTenantCompanyId(): number | null;
//# sourceMappingURL=tenantContext.d.ts.map