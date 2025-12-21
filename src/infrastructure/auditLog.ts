import type { Prisma } from '@prisma/client';

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

export async function writeAuditLog(tx: PrismaTx, input: AuditLogWrite) {
  const entityId =
    input.entityId === undefined || input.entityId === null ? null : String(input.entityId);

  // Never let audit logging break core flows: best-effort insert.
  try {
    await (tx as any).auditLog.create({
      data: {
        companyId: input.companyId,
        userId: input.userId ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId,
        idempotencyKey: input.idempotencyKey ?? null,
        correlationId: input.correlationId ?? null,
        metadata: (input.metadata ?? null) as Prisma.InputJsonValue,
      },
    });
  } catch {
    // best-effort
  }
}


