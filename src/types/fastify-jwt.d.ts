import '@fastify/jwt';
import 'fastify';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { userId: number; email: string; companyId: number; role: import('@prisma/client').UserRole };
    user: { userId: number; email: string; companyId: number; role: import('@prisma/client').UserRole };
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: any, reply: any) => Promise<void>;
  }
}


