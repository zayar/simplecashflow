import type { FastifyReply, FastifyRequest } from 'fastify';
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
export declare function requireIntegrationKey(request: FastifyRequest, reply: FastifyReply, envVarName: string): boolean;
//# sourceMappingURL=integrationAuth.d.ts.map