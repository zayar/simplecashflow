import type { FastifyInstance } from 'fastify';
import { prisma } from '../../infrastructure/db.js';
import bcrypt from 'bcryptjs';
import { DEFAULT_ACCOUNTS } from '../companies/company.constants.js';
import {
  AccountType,
  BankingAccountKind,
  CashflowActivity,
  NormalBalance,
  UserRole,
} from '@prisma/client';

export async function authRoutes(fastify: FastifyInstance) {
  const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN ?? '8h';

  function validatePasswordPolicy(password: string) {
    // Minimal policy to reduce credential stuffing / weak password risk.
    // Adjust to your org policy as needed.
    if (password.length < 8) {
      throw Object.assign(new Error('password must be at least 8 characters'), { statusCode: 400 });
    }
    const hasLower = /[a-z]/.test(password);
    const hasUpper = /[A-Z]/.test(password);
    const hasDigit = /\d/.test(password);
    if (!hasLower || !hasUpper || !hasDigit) {
      throw Object.assign(
        new Error('password must include at least 1 uppercase letter, 1 lowercase letter, and 1 number'),
        { statusCode: 400 }
      );
    }
  }

  fastify.post('/register', async (request, reply) => {
    const body = request.body as {
      email?: string;
      password?: string;
      name?: string;
      companyName?: string;
    };

    if (!body.email || !body.password || !body.companyName) {
      reply.status(400);
      return { error: 'email, password, and companyName are required' };
    }

    try {
      validatePasswordPolicy(body.password);
    } catch (err: any) {
      reply.status(err?.statusCode ?? 400);
      return { error: err?.message ?? 'invalid password' };
    }

    const existingUser = await prisma.user.findUnique({
      where: { email: body.email },
    });

    if (existingUser) {
      reply.status(400);
      return { error: 'email already exists' };
    }

    const hashedPassword = await bcrypt.hash(body.password, 10);

    const result = await prisma.$transaction(async (tx) => {
      const company = await tx.company.create({
        data: {
          name: body.companyName!,
          accounts: {
            create: DEFAULT_ACCOUNTS.map((acc) => ({
              code: acc.code,
              name: acc.name,
              type: acc.type,
              normalBalance: normalBalanceForType(acc.type),
              reportGroup: acc.reportGroup ?? null,
              cashflowActivity: acc.cashflowActivity ?? null,
            })),
          },
        },
        include: { accounts: true },
      });

      // Create default location (Inventory V1)
      const location = await tx.location.create({
        data: {
          companyId: company.id,
          name: 'Main Location',
          isDefault: true,
        },
      });

      // Find and link Accounts Receivable
      const arAccount = company.accounts.find(a => a.name === "Accounts Receivable");
      if (arAccount) {
        await tx.company.update({
          where: { id: company.id },
          data: { accountsReceivableAccountId: arAccount.id }
        });
      }

      // Find and link Accounts Payable (for Bills/AP flow)
      const apAccount = company.accounts.find((a) => a.code === '2000' || a.name === 'Accounts Payable');
      if (apAccount) {
        await tx.company.update({
          where: { id: company.id },
          data: { accountsPayableAccountId: apAccount.id },
        });
      }

      // Link Inventory / COGS / Opening Balance Equity defaults (Inventory V1)
      const inventoryAccount = company.accounts.find((a) => a.code === '1300' || a.name === 'Inventory');
      const cogsAccount = company.accounts.find((a) => a.code === '5001' || a.name === 'Cost of Goods Sold');
      const openingEquity = company.accounts.find((a) => a.code === '3050' || a.name === 'Opening Balance Equity');

      await tx.company.update({
        where: { id: company.id },
        data: {
          defaultLocationId: location.id,
          ...(inventoryAccount ? { inventoryAssetAccountId: inventoryAccount.id } : {}),
          ...(cogsAccount ? { cogsAccountId: cogsAccount.id } : {}),
          ...(openingEquity ? { openingBalanceEquityAccountId: openingEquity.id } : {}),
        },
      });

      // Create default BankingAccount for Cash (so "Deposit To" can be restricted safely).
      const cashAccount = company.accounts.find(
        (a) => a.code === '1000' || a.name.toLowerCase().includes('cash')
      );
      if (cashAccount) {
        // Ensure it's an ASSET account
        if (cashAccount.type === AccountType.ASSET) {
          await tx.bankingAccount.create({
            data: {
              companyId: company.id,
              accountId: cashAccount.id,
              kind: BankingAccountKind.CASH,
              bankName: null,
              accountNumber: null,
              identifierCode: null,
              branch: null,
              description: 'Default cash account',
              isPrimary: true,
            },
          });
        }
      }

      const user = await tx.user.create({
        data: {
          email: body.email!,
          password: hashedPassword,
          name: body.name ?? null,
          companyId: company.id,
          role: UserRole.OWNER,
        },
      });

      return { user, company };
    });

    const token = fastify.jwt.sign({
      userId: result.user.id,
      email: result.user.email,
      companyId: result.company.id,
      role: result.user.role,
    }, { expiresIn: JWT_EXPIRES_IN });

    return {
      token,
      user: {
        id: result.user.id,
        email: result.user.email,
        name: result.user.name,
        companyId: result.company.id,
        role: result.user.role,
      },
    };
  });

  fastify.post('/login', async (request, reply) => {
    const body = request.body as {
      email?: string;
      password?: string;
    };

    if (!body.email || !body.password) {
      reply.status(400);
      return { error: 'email and password are required' };
    }

    const user = await prisma.user.findUnique({
      where: { email: body.email },
    });

    if (!user) {
      reply.status(401);
      return { error: 'invalid credentials' };
    }

    const valid = await bcrypt.compare(body.password, user.password);
    if (!valid) {
      reply.status(401);
      return { error: 'invalid credentials' };
    }

    const token = fastify.jwt.sign({
      userId: user.id,
      email: user.email,
      companyId: user.companyId,
      role: (user as any).role ?? UserRole.OWNER,
    }, { expiresIn: JWT_EXPIRES_IN });

    return {
      token,
      user: { id: user.id, email: user.email, name: user.name, companyId: user.companyId, role: (user as any).role ?? UserRole.OWNER },
    };
  });

  function normalBalanceForType(type: AccountType): NormalBalance {
    switch (type) {
      case AccountType.ASSET:
      case AccountType.EXPENSE:
        return NormalBalance.DEBIT;
      case AccountType.LIABILITY:
      case AccountType.EQUITY:
      case AccountType.INCOME:
        return NormalBalance.CREDIT;
      default:
        return NormalBalance.DEBIT;
    }
  }
}

