import { prisma } from '../../infrastructure/db.js';
import { AccountReportGroup, AccountType, BankingAccountKind, CashflowActivity, NormalBalance, } from '@prisma/client';
import { DEFAULT_ACCOUNTS } from './company.constants.js';
import { enforceCompanyScope, forbidClientProvidedCompanyId, getAuthCompanyId, requireCompanyIdParam, } from '../../utils/tenant.js';
export async function companiesRoutes(fastify) {
    // Company endpoints are tenant scoped; require JWT.
    fastify.addHook('preHandler', fastify.authenticate);
    // List companies
    fastify.get('/companies', async (request) => {
        const companyId = getAuthCompanyId(request);
        // Return only the authenticated tenant's company.
        const company = await prisma.company.findUnique({
            where: { id: companyId },
        });
        return company ? [company] : [];
    });
    // Create company
    fastify.post('/companies', async (request, reply) => {
        // In production fintech: creating a company is part of onboarding (/register)
        // and should not be exposed as a general authenticated endpoint.
        reply.status(403);
        return { error: 'forbidden: use /register to create a company' };
    });
    // --- Company settings (Books layer) ---
    fastify.get('/companies/:companyId/settings', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const company = await prisma.company.findUnique({
            where: { id: companyId },
            include: {
                accountsReceivableAccount: true,
                accountsPayableAccount: true,
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
            accountsPayableAccountId: company.accountsPayableAccountId ?? null,
            accountsPayableAccount: company.accountsPayableAccount
                ? {
                    id: company.accountsPayableAccount.id,
                    code: company.accountsPayableAccount.code,
                    name: company.accountsPayableAccount.name,
                    type: company.accountsPayableAccount.type,
                }
                : null,
        };
    });
    fastify.put('/companies/:companyId/settings', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const body = request.body;
        if (!('accountsReceivableAccountId' in body) && !('accountsPayableAccountId' in body)) {
            reply.status(400);
            return { error: 'accountsReceivableAccountId and/or accountsPayableAccountId is required (number or null)' };
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
        if (body.accountsPayableAccountId !== undefined && body.accountsPayableAccountId !== null) {
            const apId = body.accountsPayableAccountId;
            if (!apId || Number.isNaN(Number(apId))) {
                reply.status(400);
                return { error: 'accountsPayableAccountId must be a valid number or null' };
            }
            const apAccount = await prisma.account.findFirst({
                where: { id: apId, companyId, type: AccountType.LIABILITY },
            });
            if (!apAccount) {
                reply.status(400);
                return { error: 'accountsPayableAccountId must be a LIABILITY account in this company' };
            }
        }
        const updated = await prisma.company.update({
            where: { id: companyId },
            data: {
                ...(body.accountsReceivableAccountId !== undefined
                    ? { accountsReceivableAccountId: body.accountsReceivableAccountId }
                    : {}),
                ...(body.accountsPayableAccountId !== undefined
                    ? { accountsPayableAccountId: body.accountsPayableAccountId }
                    : {}),
            },
            include: {
                accountsReceivableAccount: true,
                accountsPayableAccount: true,
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
            accountsPayableAccountId: updated.accountsPayableAccountId ?? null,
            accountsPayableAccount: updated.accountsPayableAccount
                ? {
                    id: updated.accountsPayableAccount.id,
                    code: updated.accountsPayableAccount.code,
                    name: updated.accountsPayableAccount.name,
                    type: updated.accountsPayableAccount.type,
                }
                : null,
        };
    });
    // --- Account APIs ---
    // List accounts for a company
    fastify.get('/companies/:companyId/accounts', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const query = request.query;
        const accounts = await prisma.account.findMany({
            where: {
                companyId,
                ...(query.type ? { type: query.type } : {}),
            },
            orderBy: { code: 'asc' },
        });
        return accounts;
    });
    // Create an account (preferred tenant-scoped endpoint)
    fastify.post('/companies/:companyId/accounts', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const body = request.body;
        if (!body.code || !body.name || !body.type) {
            reply.status(400);
            return { error: 'code, name, type are required' };
        }
        const account = await prisma.account.create({
            data: {
                companyId,
                code: body.code,
                name: body.name,
                type: body.type,
                normalBalance: normalBalanceForType(body.type),
                reportGroup: body.reportGroup ?? null,
                cashflowActivity: body.cashflowActivity ?? null,
            },
        });
        return account;
    });
    // Create an account (legacy endpoint; kept for backward compatibility)
    // IMPORTANT: companyId is derived from JWT; client-provided companyId is forbidden.
    fastify.post('/accounts', async (request, reply) => {
        const body = request.body;
        const companyId = forbidClientProvidedCompanyId(request, reply, body.companyId);
        if (!body.code || !body.name || !body.type) {
            reply.status(400);
            return { error: 'code, name, type are required' };
        }
        const account = await prisma.account.create({
            data: {
                companyId,
                code: body.code,
                name: body.name,
                type: body.type,
                normalBalance: normalBalanceForType(body.type),
                reportGroup: body.reportGroup ?? null,
                cashflowActivity: body.cashflowActivity ?? null,
            },
        });
        return account;
    });
    // --- Banking accounts (Cash/Bank/E-wallet) ---
    // These are liquidity accounts used for "Deposit To" and for cash/bank movements.
    // They map 1:1 to a Chart of Accounts Account (ASSET).
    fastify.get('/companies/:companyId/banking-accounts', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const rows = await prisma.bankingAccount.findMany({
            where: { companyId },
            include: {
                account: { select: { id: true, code: true, name: true, type: true } },
            },
            orderBy: [{ isPrimary: 'desc' }, { account: { code: 'asc' } }],
        });
        // Backward compatibility: ensure company has a CASH BankingAccount row for default cash account (code 1000).
        const hasCash = rows.some((r) => r.kind === BankingAccountKind.CASH);
        if (!hasCash) {
            const cash = await prisma.account.findFirst({
                where: { companyId, type: AccountType.ASSET, code: '1000' },
                select: { id: true, code: true, name: true, type: true },
            });
            if (cash) {
                try {
                    const created = await prisma.bankingAccount.create({
                        data: {
                            companyId,
                            accountId: cash.id,
                            kind: BankingAccountKind.CASH,
                            description: 'Default cash account',
                            isPrimary: rows.length === 0, // only primary if no other banking accounts exist
                        },
                        include: {
                            account: { select: { id: true, code: true, name: true, type: true } },
                        },
                    });
                    rows.unshift(created);
                }
                catch {
                    // Another request might have created it concurrently; ignore.
                }
            }
        }
        return rows.map((r) => ({
            id: r.id,
            kind: r.kind,
            isPrimary: r.isPrimary,
            bankName: r.bankName,
            accountNumber: r.accountNumber,
            identifierCode: r.identifierCode,
            branch: r.branch,
            description: r.description,
            account: r.account,
        }));
    });
    // Banking account detail: balance + recent transactions for UI
    fastify.get('/companies/:companyId/banking-accounts/:bankingAccountId', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const bankingAccountId = Number(request.params?.bankingAccountId);
        if (Number.isNaN(bankingAccountId)) {
            reply.status(400);
            return { error: 'invalid bankingAccountId' };
        }
        const banking = await prisma.bankingAccount.findFirst({
            where: { id: bankingAccountId, companyId },
            include: {
                account: { select: { id: true, code: true, name: true, type: true } },
            },
        });
        if (!banking) {
            reply.status(404);
            return { error: 'banking account not found' };
        }
        const sums = await prisma.journalLine.aggregate({
            where: { companyId, accountId: banking.accountId },
            _sum: { debit: true, credit: true },
        });
        const totalDebit = Number(sums._sum.debit ?? 0);
        const totalCredit = Number(sums._sum.credit ?? 0);
        // For ASSET accounts: balance = debit - credit.
        // (We only allow ASSET accounts for BankingAccount today.)
        const balance = totalDebit - totalCredit;
        const lines = await prisma.journalLine.findMany({
            where: { companyId, accountId: banking.accountId },
            orderBy: [
                { journalEntry: { date: 'desc' } },
                { journalEntryId: 'desc' },
                { id: 'desc' },
            ],
            take: 50,
            include: {
                journalEntry: {
                    include: {
                        invoice: true,
                        payment: { include: { invoice: true } },
                    },
                },
            },
        });
        const transactions = lines.map((l) => {
            const je = l.journalEntry;
            const type = je?.payment ? 'Invoice Payment' : je?.invoice ? 'Invoice Posted' : 'Journal Entry';
            const details = je?.payment?.invoice?.invoiceNumber
                ? `Payment for ${je.payment.invoice.invoiceNumber}`
                : je?.invoice?.invoiceNumber
                    ? `Invoice ${je.invoice.invoiceNumber}`
                    : je?.description ?? '';
            return {
                date: je?.date ?? null,
                type,
                details,
                journalEntryId: l.journalEntryId,
                debit: l.debit.toString(),
                credit: l.credit.toString(),
            };
        });
        return {
            id: banking.id,
            kind: banking.kind,
            isPrimary: banking.isPrimary,
            bankName: banking.bankName,
            accountNumber: banking.accountNumber,
            identifierCode: banking.identifierCode,
            branch: banking.branch,
            description: banking.description,
            account: banking.account,
            balance,
            transactions,
        };
    });
    fastify.post('/companies/:companyId/banking-accounts', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const body = request.body;
        if (!body.kind || !body.accountCode || !body.accountName) {
            reply.status(400);
            return { error: 'kind, accountCode, accountName are required' };
        }
        const kind = body.kind;
        if (!Object.values(BankingAccountKind).includes(kind)) {
            reply.status(400);
            return { error: 'invalid kind' };
        }
        // Bank/Cash/E-wallet should be ASSET accounts.
        const created = await prisma.$transaction(async (tx) => {
            const account = await tx.account.create({
                data: {
                    companyId,
                    code: body.accountCode,
                    name: body.accountName,
                    type: AccountType.ASSET,
                    normalBalance: NormalBalance.DEBIT,
                    reportGroup: AccountReportGroup.CASH_AND_CASH_EQUIVALENTS,
                    cashflowActivity: CashflowActivity.OPERATING,
                },
            });
            // If primary, unset other primaries
            if (body.isPrimary) {
                await tx.bankingAccount.updateMany({
                    where: { companyId, isPrimary: true },
                    data: { isPrimary: false },
                });
            }
            const banking = await tx.bankingAccount.create({
                data: {
                    companyId,
                    accountId: account.id,
                    kind,
                    bankName: body.bankName ?? null,
                    accountNumber: body.accountNumber ?? null,
                    identifierCode: body.identifierCode ?? null,
                    branch: body.branch ?? null,
                    description: body.description ?? null,
                    isPrimary: body.isPrimary ?? false,
                },
                include: {
                    account: true,
                },
            });
            return banking;
        });
        return {
            id: created.id,
            kind: created.kind,
            isPrimary: created.isPrimary,
            bankName: created.bankName,
            accountNumber: created.accountNumber,
            identifierCode: created.identifierCode,
            branch: created.branch,
            description: created.description,
            account: {
                id: created.account.id,
                code: created.account.code,
                name: created.account.name,
                type: created.account.type,
            },
        };
    });
    function normalBalanceForType(type) {
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
//# sourceMappingURL=companies.routes.js.map