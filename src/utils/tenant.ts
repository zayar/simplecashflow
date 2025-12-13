import type { FastifyReply, FastifyRequest } from 'fastify';

export function getAuthCompanyId(request: FastifyRequest): number {
  const user = (request as any).user as { companyId?: number } | undefined;
  const companyId = user?.companyId;
  if (!companyId || Number.isNaN(Number(companyId))) {
    throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
  }
  return Number(companyId);
}

export function enforceCompanyScope(
  request: FastifyRequest,
  reply: FastifyReply,
  targetCompanyId: number
): number {
  const authCompanyId = getAuthCompanyId(request);
  if (authCompanyId !== targetCompanyId) {
    reply.status(403);
    throw Object.assign(new Error('forbidden (cross-tenant access)'), { statusCode: 403 });
  }
  return authCompanyId;
}

/**
 * Tiny Auth Guard for route params:
 * - Validates `:companyId` param is a number
 * - Enforces it matches the authenticated JWT companyId
 * - Returns the safe companyId
 *
 * Usage:
 *   const companyId = requireCompanyIdParam(request, reply);
 */
export function requireCompanyIdParam(
  request: FastifyRequest,
  reply: FastifyReply,
  paramName: string = 'companyId'
): number {
  const raw = (request.params as any)?.[paramName];
  const companyId = Number(raw);
  if (!raw || Number.isNaN(companyId)) {
    reply.status(400);
    throw Object.assign(new Error(`invalid ${paramName}`), { statusCode: 400 });
  }
  enforceCompanyScope(request, reply, companyId);
  return companyId;
}

export function forbidClientProvidedCompanyId(
  request: FastifyRequest,
  reply: FastifyReply,
  clientCompanyId: number | undefined
): number {
  const authCompanyId = getAuthCompanyId(request);
  if (clientCompanyId !== undefined && clientCompanyId !== authCompanyId) {
    reply.status(403);
    throw Object.assign(new Error('forbidden (companyId mismatch)'), { statusCode: 403 });
  }
  return authCompanyId;
}


