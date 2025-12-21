import type { FastifyReply, FastifyRequest } from 'fastify';
import { UserRole } from '@prisma/client';
export declare function getAuthRole(request: FastifyRequest): UserRole | null;
export declare function requireAnyRole(request: FastifyRequest, reply: FastifyReply, allowed: readonly UserRole[], actionLabel?: string): UserRole;
export declare const Roles: {
    OWNER: "OWNER";
    ACCOUNTANT: "ACCOUNTANT";
    CLERK: "CLERK";
    VIEWER: "VIEWER";
};
//# sourceMappingURL=rbac.d.ts.map