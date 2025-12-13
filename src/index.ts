import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from 'fastify-jwt';
import { authRoutes } from './modules/auth/auth.routes.js';
import { companiesRoutes } from './modules/companies/companies.routes.js';
import { ledgerRoutes } from './modules/ledger/ledger.routes.js';
import { booksRoutes } from './modules/books/books.routes.js';
import { pitiRoutes } from './modules/integrations/piti.routes.js';

const JWT_SECRET = process.env.JWT_SECRET || 'supersecret';

const fastify = Fastify({ logger: true });

async function buildApp() {
  await fastify.register(cors, {
    origin: true,
  });

  fastify.register(jwt as any, {
    secret: JWT_SECRET,
  });

  // Decorate fastify with authenticate
  fastify.decorate('authenticate', async function (request: any, reply: any) {
    try {
      await request.jwtVerify();
    } catch (err) {
      reply.send(err);
    }
  });

  // Health check
  fastify.get('/health', async () => {
    return { status: 'ok' };
  });

  // Register Modules
  await fastify.register(authRoutes);
  await fastify.register(companiesRoutes);
  await fastify.register(ledgerRoutes);
  await fastify.register(booksRoutes);
  await fastify.register(pitiRoutes);

  return fastify;
}

const start = async () => {
  try {
    const app = await buildApp();
    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`Server running on http://localhost:${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
