export async function writeAuditLog(tx, input) {
    const entityId = input.entityId === undefined || input.entityId === null ? null : String(input.entityId);
    // Never let audit logging break core flows: best-effort insert.
    try {
        await tx.auditLog.create({
            data: {
                companyId: input.companyId,
                userId: input.userId ?? null,
                action: input.action,
                entityType: input.entityType,
                entityId,
                idempotencyKey: input.idempotencyKey ?? null,
                correlationId: input.correlationId ?? null,
                metadata: (input.metadata ?? null),
            },
        });
    }
    catch {
        // best-effort
    }
}
//# sourceMappingURL=auditLog.js.map