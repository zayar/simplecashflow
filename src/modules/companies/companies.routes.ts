import type { FastifyInstance } from 'fastify';
import { prisma } from '../../infrastructure/db.js';
import { parseCompanyId } from '../../utils/request.js';
import { AccountType } from '@prisma/client';
import { DEFAULT_ACCOUNTS } from './company.constants.js';

export async function companiesRoutes(fastify: FastifyInstance) {
  // List companies
  fastify.get('/companies', async () => {
    const companies = await prisma.company.findMany();
    return companies;
  });

  // Create company
  fastify.post('/companies', async (request, reply) => {
    const body = request.body as { name?: string };

    if (!body.name) {
      reply.status(400);
      return { error: 'name is required' };
    }

    const company = await prisma.company.create({
      data: {
        name: body.name,
        accounts: {
          create: DEFAULT_ACCOUNTS.map((acc) => ({
            code: acc.code,
            name: acc.name,
            type: acc.type,
          })),
        },
      },
      include: { accounts: true },
    });

    return company;
  });

  // --- Company settings (Books layer) ---
  fastify.get('/companies/:companyId/settings', async (request, reply) => {
    const companyId = parseCompanyId(request.params);
    if (!companyId) {
      reply.status(400);
      return { error: 'invalid companyId' };
    }

    const company = await prisma.company.findUnique({
      where: { id: companyId },
      include: {
        accountsReceivableAccount: true,
      },
    });

    if (!company) {
      reply.status(404);
      return { error: 'company not found' };
    }

    return {
      companyId: company.id,
      name: company.name,
      accountsReceivableAccountId: company.accountsReceivableAccountId,
      accountsReceivableAccount: company.accountsReceivableAccount
        ? {
            id: company.accountsReceivableAccount.id,
            code: company.accountsReceivableAccount.code,
            name: company.accountsReceivableAccount.name,
            type: company.accountsReceivableAccount.type,
          }
        : null,
    };
  });

  fastify.put('/companies/:companyId/settings', async (request, reply) => {
    const companyId = parseCompanyId(request.params);
    if (!companyId) {
      reply.status(400);
      return { error: 'invalid companyId' };
    }

    const body = request.body as {
      accountsReceivableAccountId?: number | null;
    };

    if (!('accountsReceivableAccountId' in body)) {
      reply.status(400);
      return { error: 'accountsReceivableAccountId is required (number or null)' };
    }

    const company = await prisma.company.findUnique({ where: { id: companyId } });
    if (!company) {
      reply.status(404);
      return { error: 'company not found' };
    }

    if (body.accountsReceivableAccountId !== null) {
      const arId = body.accountsReceivableAccountId;
      if (!arId || Number.isNaN(Number(arId))) {
        reply.status(400);
        return { error: 'accountsReceivableAccountId must be a valid number or null' };
      }

      const arAccount = await prisma.account.findFirst({
        where: { id: arId, companyId, type: AccountType.ASSET },
      });

      if (!arAccount) {
        reply.status(400);
        return { error: 'accountsReceivableAccountId must be an ASSET account in this company' };
      }
    }

    const updated = await prisma.company.update({
      where: { id: companyId },
      data: {
        accountsReceivableAccountId: body.accountsReceivableAccountId,
      },
      include: {
        accountsReceivableAccount: true,
      },
    });

    return {
      companyId: updated.id,
      name: updated.name,
      accountsReceivableAccountId: updated.accountsReceivableAccountId,
      accountsReceivableAccount: updated.accountsReceivableAccount
        ? {
            id: updated.accountsReceivableAccount.id,
            code: updated.accountsReceivableAccount.code,
            name: updated.accountsReceivableAccount.name,
            type: updated.accountsReceivableAccount.type,
          }
        : null,
    };
  });

  // --- Account APIs ---
  // List accounts for a company
  fastify.get('/companies/:companyId/accounts', async (request, reply) => {
    const { companyId } = request.params as { companyId: string };
    const query = request.query as { type?: AccountType };

    const accounts = await prisma.account.findMany({
      where: {
        companyId: Number(companyId),
        ...(query.type ? { type: query.type } : {}),
      },
      orderBy: { code: 'asc' },
    });

    return accounts;
  });

  // Create an account
  fastify.post('/accounts', async (request, reply) => {
    const body = request.body as {
      companyId?: number;
      code?: string;
      name?: string;
      type?: AccountType;
    };

    if (!body.companyId || !body.code || !body.name || !body.type) {
      reply.status(400);
      return { error: 'companyId, code, name, type are required' };
    }

    const account = await prisma.account.create({
      data: {
        companyId: body.companyId,
        code: body.code,
        name: body.name,
        type: body.type,
      },
    });

    return account;
  });
}

