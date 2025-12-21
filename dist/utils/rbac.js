import { UserRole } from '@prisma/client';
export function getAuthRole(request) {
    const role = request?.user?.role;
    if (!role)
        return null;
    return role;
}
export function requireAnyRole(request, reply, allowed, actionLabel) {
    const role = getAuthRole(request);
    if (!role) {
        reply.status(401);
        throw Object.assign(new Error('unauthenticated'), { statusCode: 401 });
    }
    if (!allowed.includes(role)) {
        reply.status(403);
        throw Object.assign(new Error(actionLabel ? `forbidden: requires ${actionLabel}` : 'forbidden'), { statusCode: 403 });
    }
    return role;
}
export const Roles = UserRole;
//# sourceMappingURL=rbac.js.map