export type AuditLogWrite = {
    companyId: number;
    userId?: number | null;
    action: string;
    entityType: string;
    entityId?: string | number | null;
    idempotencyKey?: string | null;
    correlationId?: string | null;
    metadata?: unknown;
};
type PrismaTx = any;
export declare function writeAuditLog(tx: PrismaTx, input: AuditLogWrite): Promise<void>;
export {};
//# sourceMappingURL=auditLog.d.ts.map