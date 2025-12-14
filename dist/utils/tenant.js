export function getAuthCompanyId(request) {
    const user = request.user;
    const companyId = user?.companyId;
    if (!companyId || Number.isNaN(Number(companyId))) {
        throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
    }
    return Number(companyId);
}
export function enforceCompanyScope(request, reply, targetCompanyId) {
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
export function requireCompanyIdParam(request, reply, paramName = 'companyId') {
    const raw = request.params?.[paramName];
    const companyId = Number(raw);
    if (!raw || Number.isNaN(companyId)) {
        reply.status(400);
        throw Object.assign(new Error(`invalid ${paramName}`), { statusCode: 400 });
    }
    enforceCompanyScope(request, reply, companyId);
    return companyId;
}
export function forbidClientProvidedCompanyId(request, reply, clientCompanyId) {
    const authCompanyId = getAuthCompanyId(request);
    if (clientCompanyId !== undefined && clientCompanyId !== authCompanyId) {
        reply.status(403);
        throw Object.assign(new Error('forbidden (companyId mismatch)'), { statusCode: 403 });
    }
    return authCompanyId;
}
//# sourceMappingURL=tenant.js.map