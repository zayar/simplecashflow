import type { FastifyReply, FastifyRequest } from 'fastify';
export declare function getAuthCompanyId(request: FastifyRequest): number;
export declare function enforceCompanyScope(request: FastifyRequest, reply: FastifyReply, targetCompanyId: number): number;
/**
 * Tiny Auth Guard for route params:
 * - Validates `:companyId` param is a number
 * - Enforces it matches the authenticated JWT companyId
 * - Returns the safe companyId
 *
 * Usage:
 *   const companyId = requireCompanyIdParam(request, reply);
 */
export declare function requireCompanyIdParam(request: FastifyRequest, reply: FastifyReply, paramName?: string): number;
export declare function forbidClientProvidedCompanyId(request: FastifyRequest, reply: FastifyReply, clientCompanyId: number | undefined): number;
//# sourceMappingURL=tenant.d.ts.map