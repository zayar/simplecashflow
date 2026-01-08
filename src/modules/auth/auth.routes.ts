import type { FastifyInstance } from 'fastify';
import { randomInt } from 'node:crypto';
import { prisma, rawPrisma } from '../../infrastructure/db.js';
import bcrypt from 'bcryptjs';
import { getRedis } from '../../infrastructure/redis.js';
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

  // --- Phone OTP login settings ---
  const OTP_TTL_SECONDS = Math.max(60, Number(process.env.OTP_TTL_SECONDS ?? 300)); // default 5 min
  const OTP_MAX_ATTEMPTS = Math.max(3, Number(process.env.OTP_MAX_ATTEMPTS ?? 5));
  const OTP_REQUEST_COOLDOWN_SECONDS = Math.max(5, Number(process.env.OTP_REQUEST_COOLDOWN_SECONDS ?? 30));
  const OTP_REQUEST_MAX_PER_HOUR = Math.max(3, Number(process.env.OTP_REQUEST_MAX_PER_HOUR ?? 10));
  const DEFAULT_PHONE_COUNTRY_CODE = String(process.env.DEFAULT_PHONE_COUNTRY_CODE ?? '95').replace(/\D/g, '') || '95';
  const OTP_DEBUG =
    (process.env.OTP_DEBUG ?? '').toLowerCase() === 'true' ||
    ((process.env.NODE_ENV ?? '').toLowerCase() !== 'production' &&
      (process.env.OTP_DEBUG ?? '').toLowerCase() !== 'false');

  function getClientIp(request: any): string | null {
    const ip = (request?.ip ?? request?.socket?.remoteAddress ?? null) as string | null;
    return ip ? String(ip) : null;
  }

  function normalizePhone(input: string): string {
    // Goal: store consistently so uniqueness works. Keep it simple:
    // - remove spaces/dashes/parentheses
    // - ensure it starts with "+"
    // - if user enters local "09..." (Myanmar) or leading "0...", convert using DEFAULT_PHONE_COUNTRY_CODE.
    let raw = String(input ?? '').trim();
    if (!raw) throw Object.assign(new Error('phone is required'), { statusCode: 400 });
    raw = raw.replace(/[\s()\-.]/g, '');

    // Convert "00" prefix to "+"
    if (raw.startsWith('00')) raw = `+${raw.slice(2)}`;

    if (raw.startsWith('+')) {
      const digits = raw.slice(1).replace(/\D/g, '');
      if (digits.length < 7 || digits.length > 20) {
        throw Object.assign(new Error('invalid phone number'), { statusCode: 400 });
      }
      return `+${digits}`;
    }

    // If it's all digits and starts with 0, treat as local and prefix country code.
    const digitsOnly = raw.replace(/\D/g, '');
    if (!digitsOnly) throw Object.assign(new Error('invalid phone number'), { statusCode: 400 });
    const withoutLeading0 = digitsOnly.startsWith('0') ? digitsOnly.replace(/^0+/, '') : digitsOnly;
    const normalized = `+${DEFAULT_PHONE_COUNTRY_CODE}${withoutLeading0}`;
    if (normalized.length < 8 || normalized.length > 21) {
      throw Object.assign(new Error('invalid phone number'), { statusCode: 400 });
    }
    return normalized;
  }

  function generateOtpCode(): string {
    // 6-digit numeric code
    return String(randomInt(0, 1_000_000)).padStart(6, '0');
  }

  async function bestEffortOtpGuards(phone: string): Promise<void> {
    // Redis-backed limits (best effort). If Redis is down, fall back to global IP limiter in src/index.ts.
    try {
      const redis = getRedis();
      const cooldownKey = `otp:cooldown:${phone}`;
      const hourKey = `otp:hour:${phone}`;

      // Cooldown: one OTP every N seconds per phone
      const cooldownSet = await redis.set(cooldownKey, '1', 'EX', OTP_REQUEST_COOLDOWN_SECONDS, 'NX');
      if (cooldownSet !== 'OK') {
        throw Object.assign(new Error('Please wait before requesting another OTP.'), { statusCode: 429 });
      }

      // Hour bucket: max requests/hour per phone
      const n = await redis.incr(hourKey);
      if (n === 1) await redis.expire(hourKey, 3600);
      if (n > OTP_REQUEST_MAX_PER_HOUR) {
        throw Object.assign(new Error('Too many OTP requests. Please try again later.'), { statusCode: 429 });
      }
    } catch (err: any) {
      // If it's our intentional 429, rethrow. Otherwise degrade gracefully.
      if (err?.statusCode === 429) throw err;
    }
  }

  async function createAndSendOtp(opts: {
    phone: string;
    purpose: 'login' | 'link_phone';
    requestedIp: string | null;
  }): Promise<{ expiresAt: Date; debugCode?: string }> {
    await bestEffortOtpGuards(opts.phone);

    const code = generateOtpCode();
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + OTP_TTL_SECONDS * 1000);

    await prisma.loginOtp.create({
      data: {
        phone: opts.phone,
        codeHash,
        purpose: opts.purpose,
        expiresAt,
        requestedIp: opts.requestedIp,
      },
    });

    // In production, integrate your SMS provider here (Twilio, MessageBird, local telco, etc).
    // For now we log in non-prod, and optionally expose it for local testing.
    if (OTP_DEBUG) {
      console.log(`[OTP_DEBUG] purpose=${opts.purpose} phone=${opts.phone} code=${code} ttl=${OTP_TTL_SECONDS}s`);
      return { expiresAt, debugCode: code };
    }

    // TODO: real SMS integration
    console.log(`[OTP] Sent (simulated) purpose=${opts.purpose} phone=${opts.phone} ttl=${OTP_TTL_SECONDS}s`);
    return { expiresAt };
  }

  async function verifyOtp(opts: { phone: string; purpose: 'login' | 'link_phone'; code: string; verifiedIp: string | null }) {
    const now = new Date();
    const rec = await prisma.loginOtp.findFirst({
      where: {
        phone: opts.phone,
        purpose: opts.purpose,
        consumedAt: null,
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!rec) {
      throw Object.assign(new Error('invalid or expired code'), { statusCode: 401 });
    }
    if (rec.attempts >= OTP_MAX_ATTEMPTS) {
      throw Object.assign(new Error('too many attempts, request a new code'), { statusCode: 429 });
    }

    const ok = await bcrypt.compare(opts.code, rec.codeHash);
    if (!ok) {
      await prisma.loginOtp.update({
        where: { id: rec.id },
        data: { attempts: rec.attempts + 1, verifiedIp: opts.verifiedIp ?? rec.verifiedIp },
      });
      throw Object.assign(new Error('invalid or expired code'), { statusCode: 401 });
    }

    await prisma.loginOtp.update({
      where: { id: rec.id },
      data: { consumedAt: now, verifiedIp: opts.verifiedIp ?? rec.verifiedIp },
    });

    return rec;
  }

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
      phone?: string;
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

    const normalizedPhone = body.phone ? normalizePhone(body.phone) : null;
    if (normalizedPhone) {
      // Cross-tenant uniqueness check (phone is globally unique).
      const existingPhone = await rawPrisma.user.findFirst({ where: { phone: normalizedPhone } });
      if (existingPhone) {
        reply.status(400);
        return { error: 'phone already exists' };
      }
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
          phone: normalizedPhone,
          phoneVerifiedAt: null,
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

  // --- Phone OTP login (unauthenticated) ---
  fastify.post('/login/otp/request', async (request, reply) => {
    const body = request.body as { phone?: string };
    if (!body.phone) {
      reply.status(400);
      return { error: 'phone is required' };
    }

    const phone = normalizePhone(body.phone);
    const ip = getClientIp(request);
    try {
      const { expiresAt, debugCode } = await createAndSendOtp({ phone, purpose: 'login', requestedIp: ip });
      return {
        ok: true,
        expiresAt: expiresAt.toISOString(),
        ...(OTP_DEBUG ? { debugCode } : {}),
      };
    } catch (err: any) {
      reply.status(err?.statusCode ?? 400);
      return { error: err?.message ?? 'failed to request otp' };
    }
  });

  fastify.post('/login/otp/verify', async (request, reply) => {
    const body = request.body as { phone?: string; code?: string };
    if (!body.phone || !body.code) {
      reply.status(400);
      return { error: 'phone and code are required' };
    }

    const phone = normalizePhone(body.phone);
    const code = String(body.code).trim();
    const ip = getClientIp(request);

    try {
      await verifyOtp({ phone, purpose: 'login', code, verifiedIp: ip });
    } catch (err: any) {
      reply.status(err?.statusCode ?? 401);
      return { error: err?.message ?? 'invalid or expired code' };
    }

    // No tenant context here (unauthenticated). Safe to use tenant-scoped prisma.
    const user = await prisma.user.findFirst({ where: { phone } });

    if (!user) {
      reply.status(404);
      return { error: 'phone is not linked to any account (please link it from Settings first)' };
    }

    // OTP itself is proof-of-possession, so mark verified on first successful OTP login.
    if (!(user as any).phoneVerifiedAt) {
      await prisma.user.update({
        where: { email: user.email }, // no tenant ctx; email is unique
        data: { phoneVerifiedAt: new Date() },
      });
    }

    const token = fastify.jwt.sign(
      {
        userId: user.id,
        email: user.email,
        companyId: user.companyId,
        role: (user as any).role ?? UserRole.OWNER,
      },
      { expiresIn: JWT_EXPIRES_IN }
    );

    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        companyId: user.companyId,
        role: (user as any).role ?? UserRole.OWNER,
        phone: (user as any).phone ?? null,
        phoneVerifiedAt: (user as any).phoneVerifiedAt ?? null,
      },
    };
  });

  // --- "Me" endpoints (authenticated) ---
  fastify.get('/me', { preHandler: (fastify as any).authenticate }, async (request, reply) => {
    const jwtUser = (request as any).user as { userId?: number; companyId?: number } | undefined;
    const userId = Number(jwtUser?.userId);
    const companyId = Number(jwtUser?.companyId);
    if (!Number.isInteger(userId) || userId <= 0 || !Number.isInteger(companyId) || companyId <= 0) {
      reply.status(401);
      return { error: 'unauthorized' };
    }

    const user = await prisma.user.findFirst({
      where: { id: userId, companyId },
      select: {
        id: true,
        email: true,
        name: true,
        companyId: true,
        role: true,
        phone: true,
        phoneVerifiedAt: true,
      },
    });

    if (!user) {
      reply.status(404);
      return { error: 'user not found' };
    }
    return user;
  });

  fastify.post('/me/phone/request-otp', { preHandler: (fastify as any).authenticate }, async (request, reply) => {
    const body = request.body as { phone?: string };
    const jwtUser = (request as any).user as { userId?: number; companyId?: number } | undefined;
    const userId = Number(jwtUser?.userId);
    const companyId = Number(jwtUser?.companyId);
    if (!Number.isInteger(userId) || userId <= 0 || !Number.isInteger(companyId) || companyId <= 0) {
      reply.status(401);
      return { error: 'unauthorized' };
    }
    if (!body.phone) {
      reply.status(400);
      return { error: 'phone is required' };
    }

    const phone = normalizePhone(body.phone);
    const ip = getClientIp(request);

    // Ensure phone isn't already linked to another user.
    // Cross-tenant uniqueness check (phone is globally unique).
    const existing = await rawPrisma.user.findFirst({
      where: { phone, id: { not: userId } },
      select: { id: true },
    });
    if (existing) {
      reply.status(400);
      return { error: 'phone is already linked to another account' };
    }

    try {
      const { expiresAt, debugCode } = await createAndSendOtp({ phone, purpose: 'link_phone', requestedIp: ip });
      return {
        ok: true,
        expiresAt: expiresAt.toISOString(),
        ...(OTP_DEBUG ? { debugCode } : {}),
      };
    } catch (err: any) {
      reply.status(err?.statusCode ?? 400);
      return { error: err?.message ?? 'failed to request otp' };
    }
  });

  fastify.post('/me/phone/verify', { preHandler: (fastify as any).authenticate }, async (request, reply) => {
    const body = request.body as { phone?: string; code?: string };
    const jwtUser = (request as any).user as { userId?: number; companyId?: number } | undefined;
    const userId = Number(jwtUser?.userId);
    const companyId = Number(jwtUser?.companyId);
    if (!Number.isInteger(userId) || userId <= 0 || !Number.isInteger(companyId) || companyId <= 0) {
      reply.status(401);
      return { error: 'unauthorized' };
    }
    if (!body.phone || !body.code) {
      reply.status(400);
      return { error: 'phone and code are required' };
    }

    const phone = normalizePhone(body.phone);
    const code = String(body.code).trim();
    const ip = getClientIp(request);

    // Ensure phone isn't already linked to another user.
    // Cross-tenant uniqueness check (phone is globally unique).
    const existing = await rawPrisma.user.findFirst({
      where: { phone, id: { not: userId } },
      select: { id: true },
    });
    if (existing) {
      reply.status(400);
      return { error: 'phone is already linked to another account' };
    }

    try {
      await verifyOtp({ phone, purpose: 'link_phone', code, verifiedIp: ip });
    } catch (err: any) {
      reply.status(err?.statusCode ?? 401);
      return { error: err?.message ?? 'invalid or expired code' };
    }

    const now = new Date();
    try {
      const updated = await prisma.user.updateMany({
        where: { id: userId, companyId },
        data: { phone, phoneVerifiedAt: now },
      });
      if (updated.count !== 1) {
        reply.status(404);
        return { error: 'user not found' };
      }
    } catch (err: any) {
      // Prisma unique constraint violation (phone already linked)
      if (err?.code === 'P2002') {
        reply.status(400);
        return { error: 'phone is already linked to another account' };
      }
      throw err;
    }

    return { ok: true, phone, phoneVerifiedAt: now.toISOString() };
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

