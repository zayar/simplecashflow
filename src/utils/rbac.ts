import type { FastifyReply, FastifyRequest } from 'fastify';
import { UserRole } from '@prisma/client';

export function getAuthRole(request: FastifyRequest): UserRole | null {
  const role = (request as any)?.user?.role as UserRole | undefined;
  if (!role) return null;
  return role;
}

export function requireAnyRole(
  request: FastifyRequest,
  reply: FastifyReply,
  allowed: readonly UserRole[],
  actionLabel?: string
): UserRole {
  const role = getAuthRole(request);
  if (!role) {
    reply.status(401);
    throw Object.assign(new Error('unauthenticated'), { statusCode: 401 });
  }
  if (!allowed.includes(role)) {
    reply.status(403);
    throw Object.assign(
      new Error(actionLabel ? `forbidden: requires ${actionLabel}` : 'forbidden'),
      { statusCode: 403 }
    );
  }
  return role;
}

export const Roles = UserRole;


