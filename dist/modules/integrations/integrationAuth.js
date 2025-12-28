/**
 * Simple service-to-service auth for integrations.
 *
 * We intentionally keep this minimal and easy for external teams:
 * - Caller sends `X-Integration-Key: <shared secret>`
 * - Cashflow compares with env var (per integration)
 *
 * Later hardening options:
 * - per-company keys
 * - HMAC signatures with timestamps (replay protection)
 * - Cloud Run service-to-service IAM (OIDC)
 */
export function requireIntegrationKey(request, reply, envVarName) {
    const expected = (process.env[envVarName] ?? '').trim();
    if (!expected) {
        reply.status(500);
        reply.send({ error: `integration auth not configured: missing ${envVarName}` });
        return false;
    }
    const key = String(request.headers?.['x-integration-key'] ?? '').trim();
    if (!key || key !== expected) {
        reply.status(401);
        reply.send({ error: 'invalid integration key' });
        return false;
    }
    return true;
}
//# sourceMappingURL=integrationAuth.js.map