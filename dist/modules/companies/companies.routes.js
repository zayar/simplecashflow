import { prisma } from '../../infrastructure/db.js';
import { AccountReportGroup, AccountType, BankingAccountKind, CashflowActivity, NormalBalance, Prisma, } from '@prisma/client';
import { Storage } from '@google-cloud/storage';
import { v4 as uuidv4 } from 'uuid';
import { DEFAULT_ACCOUNTS } from './company.constants.js';
import { enforceCompanyScope, forbidClientProvidedCompanyId, getAuthCompanyId, requireCompanyIdParam, } from '../../utils/tenant.js';
import { requireAnyRole, Roles } from '../../utils/rbac.js';
import { normalizeToDay } from '../../utils/date.js';
import { toMoneyDecimal } from '../../utils/money.js';
import { postJournalEntry } from '../ledger/posting.service.js';
const DEFAULT_INVOICE_TEMPLATE = {
    version: 1,
    logoUrl: null,
    accentColor: '#2F81B7',
    fontFamily: 'Inter',
    headerText: null,
    footerText: null,
    tableHeaderBg: '#2F81B7',
    tableHeaderText: '#FFFFFF',
};
function requireEnv(name) {
    const v = process.env[name];
    if (!v || !String(v).trim())
        throw new Error(`Missing required env var: ${name}`);
    return String(v);
}
function isHexColor(s) {
    const v = String(s ?? '').trim();
    return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v);
}
function sanitizeInvoiceTemplate(input) {
    const obj = input && typeof input === 'object' ? input : {};
    const logoUrl = typeof obj.logoUrl === 'string' && obj.logoUrl.trim()
        ? obj.logoUrl.trim()
        : obj.logoUrl === null
            ? null
            : DEFAULT_INVOICE_TEMPLATE.logoUrl;
    const accentColor = typeof obj.accentColor === 'string' && isHexColor(obj.accentColor)
        ? obj.accentColor.toUpperCase()
        : DEFAULT_INVOICE_TEMPLATE.accentColor;
    const tableHeaderBg = typeof obj.tableHeaderBg === 'string' && isHexColor(obj.tableHeaderBg)
        ? obj.tableHeaderBg.toUpperCase()
        : accentColor;
    const tableHeaderText = typeof obj.tableHeaderText === 'string' && isHexColor(obj.tableHeaderText)
        ? obj.tableHeaderText.toUpperCase()
        : DEFAULT_INVOICE_TEMPLATE.tableHeaderText;
    const fontFamily = typeof obj.fontFamily === 'string' && obj.fontFamily.trim()
        ? obj.fontFamily.trim()
        : DEFAULT_INVOICE_TEMPLATE.fontFamily;
    const headerText = typeof obj.headerText === 'string' ? obj.headerText : obj.headerText === null ? null : DEFAULT_INVOICE_TEMPLATE.headerText;
    const footerText = typeof obj.footerText === 'string' ? obj.footerText : obj.footerText === null ? null : DEFAULT_INVOICE_TEMPLATE.footerText;
    return {
        version: 1,
        logoUrl,
        accentColor,
        fontFamily,
        headerText,
        footerText,
        tableHeaderBg,
        tableHeaderText,
    };
}
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
                inventoryAssetAccount: true,
                cogsAccount: true,
                openingBalanceEquityAccount: true,
                defaultLocation: true,
            },
        });
        if (!company) {
            reply.status(404);
            return { error: 'company not found' };
        }
        // Used for base currency immutability (fintech safety):
        // - If baseCurrency is already set and transactions exist, lock it.
        // - If baseCurrency is NOT set yet, allow setting it even if transactions already exist
        //   (so features like exchange rates can be enabled for legacy companies).
        const transactionCount = await prisma.journalEntry.count({ where: { companyId } });
        return {
            companyId: company.id,
            name: company.name,
            baseCurrency: company.baseCurrency ?? null,
            timeZone: company.timeZone ?? null,
            fiscalYearStartMonth: company.fiscalYearStartMonth ?? 1,
            baseCurrencyLocked: transactionCount > 0 && !!(company.baseCurrency ?? null),
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
            inventoryAssetAccountId: company.inventoryAssetAccountId ?? null,
            inventoryAssetAccount: company.inventoryAssetAccount
                ? {
                    id: company.inventoryAssetAccount.id,
                    code: company.inventoryAssetAccount.code,
                    name: company.inventoryAssetAccount.name,
                    type: company.inventoryAssetAccount.type,
                }
                : null,
            cogsAccountId: company.cogsAccountId ?? null,
            cogsAccount: company.cogsAccount
                ? {
                    id: company.cogsAccount.id,
                    code: company.cogsAccount.code,
                    name: company.cogsAccount.name,
                    type: company.cogsAccount.type,
                }
                : null,
            openingBalanceEquityAccountId: company.openingBalanceEquityAccountId ?? null,
            openingBalanceEquityAccount: company.openingBalanceEquityAccount
                ? {
                    id: company.openingBalanceEquityAccount.id,
                    code: company.openingBalanceEquityAccount.code,
                    name: company.openingBalanceEquityAccount.name,
                    type: company.openingBalanceEquityAccount.type,
                }
                : null,
            // Location (preferred)
            defaultLocationId: company.defaultLocationId ?? null,
            defaultLocation: company.defaultLocation
                ? {
                    id: company.defaultLocation.id,
                    name: company.defaultLocation.name,
                    isDefault: company.defaultLocation.isDefault,
                }
                : null,
            // Backward compatibility (deprecated)
            defaultWarehouseId: company.defaultLocationId ?? null,
            defaultWarehouse: company.defaultLocation
                ? {
                    id: company.defaultLocation.id,
                    name: company.defaultLocation.name,
                    isDefault: company.defaultLocation.isDefault,
                }
                : null,
        };
    });
    fastify.put('/companies/:companyId/settings', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const body = request.body;
        if (!('baseCurrency' in body) &&
            !('timeZone' in body) &&
            !('fiscalYearStartMonth' in body) &&
            !('accountsReceivableAccountId' in body) &&
            !('accountsPayableAccountId' in body) &&
            !('inventoryAssetAccountId' in body) &&
            !('cogsAccountId' in body) &&
            !('openingBalanceEquityAccountId' in body) &&
            !('defaultLocationId' in body) &&
            !('defaultWarehouseId' in body)) {
            reply.status(400);
            return {
                error: 'at least one setting field is required (baseCurrency, timeZone, fiscalYearStartMonth, accountsReceivableAccountId, accountsPayableAccountId, inventoryAssetAccountId, cogsAccountId, openingBalanceEquityAccountId, defaultLocationId)',
            };
        }
        const company = await prisma.company.findUnique({ where: { id: companyId } });
        if (!company) {
            reply.status(404);
            return { error: 'company not found' };
        }
        // --- Validate and enforce company profile fields ---
        if (body.baseCurrency !== undefined) {
            const cur = body.baseCurrency;
            if (cur === null) {
                // allow clearing only if no transactions exist
                const cnt = await prisma.journalEntry.count({ where: { companyId } });
                if (cnt > 0) {
                    reply.status(400);
                    return { error: 'baseCurrency cannot be cleared after transactions exist' };
                }
            }
            else {
                const normalized = String(cur).trim().toUpperCase();
                if (!/^[A-Z]{3}$/.test(normalized)) {
                    reply.status(400);
                    return { error: 'baseCurrency must be a 3-letter currency code (e.g. MMK, USD)' };
                }
                // lock base currency after any journal entries exist
                const cnt = await prisma.journalEntry.count({ where: { companyId } });
                const existing = (company.baseCurrency ?? null);
                if (cnt > 0 && existing && existing !== normalized) {
                    reply.status(400);
                    return { error: 'baseCurrency cannot be changed after transactions exist' };
                }
                // mutate request payload to normalized value (so we store clean)
                body.baseCurrency = normalized;
            }
        }
        if (body.timeZone !== undefined && body.timeZone !== null) {
            const tz = String(body.timeZone).trim();
            if (tz.length < 3 || tz.length > 64) {
                reply.status(400);
                return { error: 'timeZone must be a valid IANA timezone name (e.g. Asia/Yangon)' };
            }
        }
        if (body.fiscalYearStartMonth !== undefined && body.fiscalYearStartMonth !== null) {
            const m = Number(body.fiscalYearStartMonth);
            if (!Number.isInteger(m) || m < 1 || m > 12) {
                reply.status(400);
                return { error: 'fiscalYearStartMonth must be an integer between 1 and 12' };
            }
        }
        if (body.accountsReceivableAccountId !== undefined && body.accountsReceivableAccountId !== null) {
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
        if (body.inventoryAssetAccountId !== undefined && body.inventoryAssetAccountId !== null) {
            const invId = body.inventoryAssetAccountId;
            if (!invId || Number.isNaN(Number(invId))) {
                reply.status(400);
                return { error: 'inventoryAssetAccountId must be a valid number or null' };
            }
            const invAcc = await prisma.account.findFirst({
                where: { id: invId, companyId, type: AccountType.ASSET },
            });
            if (!invAcc) {
                reply.status(400);
                return { error: 'inventoryAssetAccountId must be an ASSET account in this company' };
            }
        }
        if (body.cogsAccountId !== undefined && body.cogsAccountId !== null) {
            const cogsId = body.cogsAccountId;
            if (!cogsId || Number.isNaN(Number(cogsId))) {
                reply.status(400);
                return { error: 'cogsAccountId must be a valid number or null' };
            }
            const cogsAcc = await prisma.account.findFirst({
                where: { id: cogsId, companyId, type: AccountType.EXPENSE },
            });
            if (!cogsAcc) {
                reply.status(400);
                return { error: 'cogsAccountId must be an EXPENSE account in this company' };
            }
        }
        if (body.openingBalanceEquityAccountId !== undefined && body.openingBalanceEquityAccountId !== null) {
            const eqId = body.openingBalanceEquityAccountId;
            if (!eqId || Number.isNaN(Number(eqId))) {
                reply.status(400);
                return { error: 'openingBalanceEquityAccountId must be a valid number or null' };
            }
            const eqAcc = await prisma.account.findFirst({
                where: { id: eqId, companyId, type: AccountType.EQUITY },
            });
            if (!eqAcc) {
                reply.status(400);
                return { error: 'openingBalanceEquityAccountId must be an EQUITY account in this company' };
            }
        }
        const desiredDefaultLocationId = body.defaultLocationId !== undefined ? body.defaultLocationId : body.defaultWarehouseId;
        if (desiredDefaultLocationId !== undefined && desiredDefaultLocationId !== null) {
            const locId = desiredDefaultLocationId;
            if (!locId || Number.isNaN(Number(locId))) {
                reply.status(400);
                return { error: 'defaultLocationId must be a valid number or null' };
            }
            const loc = await prisma.location.findFirst({ where: { id: locId, companyId } });
            if (!loc) {
                reply.status(400);
                return { error: 'defaultLocationId must be a location in this company' };
            }
        }
        const updated = await prisma.company.update({
            where: { id: companyId },
            data: {
                ...(body.baseCurrency !== undefined ? { baseCurrency: body.baseCurrency } : {}),
                ...(body.timeZone !== undefined ? { timeZone: body.timeZone } : {}),
                ...(body.fiscalYearStartMonth !== undefined
                    ? { fiscalYearStartMonth: body.fiscalYearStartMonth }
                    : {}),
                ...(body.accountsReceivableAccountId !== undefined
                    ? { accountsReceivableAccountId: body.accountsReceivableAccountId }
                    : {}),
                ...(body.accountsPayableAccountId !== undefined
                    ? { accountsPayableAccountId: body.accountsPayableAccountId }
                    : {}),
                ...(body.inventoryAssetAccountId !== undefined
                    ? { inventoryAssetAccountId: body.inventoryAssetAccountId }
                    : {}),
                ...(body.cogsAccountId !== undefined ? { cogsAccountId: body.cogsAccountId } : {}),
                ...(body.openingBalanceEquityAccountId !== undefined
                    ? { openingBalanceEquityAccountId: body.openingBalanceEquityAccountId }
                    : {}),
                ...(desiredDefaultLocationId !== undefined ? { defaultLocationId: desiredDefaultLocationId } : {}),
            },
            include: {
                accountsReceivableAccount: true,
                accountsPayableAccount: true,
                inventoryAssetAccount: true,
                cogsAccount: true,
                openingBalanceEquityAccount: true,
                defaultLocation: true,
            },
        });
        const transactionCount = await prisma.journalEntry.count({ where: { companyId } });
        return {
            companyId: updated.id,
            name: updated.name,
            baseCurrency: updated.baseCurrency ?? null,
            timeZone: updated.timeZone ?? null,
            fiscalYearStartMonth: updated.fiscalYearStartMonth ?? 1,
            baseCurrencyLocked: transactionCount > 0 && !!(updated.baseCurrency ?? null),
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
            inventoryAssetAccountId: updated.inventoryAssetAccountId ?? null,
            inventoryAssetAccount: updated.inventoryAssetAccount
                ? {
                    id: updated.inventoryAssetAccount.id,
                    code: updated.inventoryAssetAccount.code,
                    name: updated.inventoryAssetAccount.name,
                    type: updated.inventoryAssetAccount.type,
                }
                : null,
            cogsAccountId: updated.cogsAccountId ?? null,
            cogsAccount: updated.cogsAccount
                ? {
                    id: updated.cogsAccount.id,
                    code: updated.cogsAccount.code,
                    name: updated.cogsAccount.name,
                    type: updated.cogsAccount.type,
                }
                : null,
            openingBalanceEquityAccountId: updated.openingBalanceEquityAccountId ?? null,
            openingBalanceEquityAccount: updated.openingBalanceEquityAccount
                ? {
                    id: updated.openingBalanceEquityAccount.id,
                    code: updated.openingBalanceEquityAccount.code,
                    name: updated.openingBalanceEquityAccount.name,
                    type: updated.openingBalanceEquityAccount.type,
                }
                : null,
            // Location (preferred)
            defaultLocationId: updated.defaultLocationId ?? null,
            defaultLocation: updated.defaultLocation
                ? {
                    id: updated.defaultLocation.id,
                    name: updated.defaultLocation.name,
                    isDefault: updated.defaultLocation.isDefault,
                }
                : null,
            // Backward compatibility (deprecated)
            defaultWarehouseId: updated.defaultLocationId ?? null,
            defaultWarehouse: updated.defaultLocation
                ? {
                    id: updated.defaultLocation.id,
                    name: updated.defaultLocation.name,
                    isDefault: updated.defaultLocation.isDefault,
                }
                : null,
        };
    });
    // --- Invoice Template (print/design settings) ---
    fastify.get('/companies/:companyId/invoice-template', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const company = await prisma.company.findUnique({
            where: { id: companyId },
            select: { id: true, invoiceTemplate: true },
        });
        if (!company) {
            reply.status(404);
            return { error: 'company not found' };
        }
        const stored = company.invoiceTemplate ?? null;
        const merged = sanitizeInvoiceTemplate(stored);
        return merged;
    });
    fastify.put('/companies/:companyId/invoice-template', async (request, reply) => {
        // Only allow privileged roles to change print templates.
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER/ACCOUNTANT');
        const companyId = requireCompanyIdParam(request, reply);
        const body = request.body;
        // Allow clearing via { clear: true }
        if (body && typeof body === 'object' && body.clear === true) {
            const updated = await prisma.company.update({
                where: { id: companyId },
                data: { invoiceTemplate: null },
                select: { invoiceTemplate: true },
            });
            return sanitizeInvoiceTemplate(updated.invoiceTemplate);
        }
        if (!body || typeof body !== 'object') {
            reply.status(400);
            return { error: 'template body must be an object' };
        }
        const template = sanitizeInvoiceTemplate(body);
        const updated = await prisma.company.update({
            where: { id: companyId },
            data: { invoiceTemplate: template },
            select: { invoiceTemplate: true },
        });
        return sanitizeInvoiceTemplate(updated.invoiceTemplate);
    });
    // Upload logo to GCS and update invoice template.logoUrl
    fastify.post('/companies/:companyId/invoice-template/logo', async (request, reply) => {
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER/ACCOUNTANT');
        const companyId = requireCompanyIdParam(request, reply);
        // @fastify/multipart
        const file = await request.file?.();
        if (!file) {
            reply.status(400);
            return { error: 'file is required (multipart/form-data field: file)' };
        }
        const mimetype = String(file.mimetype ?? '');
        if (!mimetype.startsWith('image/')) {
            reply.status(400);
            return { error: 'only image uploads are allowed' };
        }
        const bucketName = requireEnv('INVOICE_TEMPLATE_ASSETS_BUCKET');
        const storage = new Storage();
        const ext = mimetype === 'image/png' ? '.png' : mimetype === 'image/jpeg' ? '.jpg' : '';
        const objectName = `companies/${companyId}/invoice-template/logo/${uuidv4()}${ext}`;
        // Save to GCS (buffering is fine for small 1MB default)
        const buf = await file.toBuffer();
        await storage.bucket(bucketName).file(objectName).save(buf, {
            contentType: mimetype,
            resumable: false,
            metadata: {
                cacheControl: 'public, max-age=31536000',
            },
        });
        const publicUrl = `https://storage.googleapis.com/${bucketName}/${objectName}`;
        // Update stored template with the new logoUrl
        const company = await prisma.company.findUnique({
            where: { id: companyId },
            select: { invoiceTemplate: true },
        });
        const next = sanitizeInvoiceTemplate(company?.invoiceTemplate ?? null);
        next.logoUrl = publicUrl;
        const updated = await prisma.company.update({
            where: { id: companyId },
            data: { invoiceTemplate: next },
            select: { invoiceTemplate: true },
        });
        return {
            logoUrl: publicUrl,
            template: sanitizeInvoiceTemplate(updated.invoiceTemplate),
        };
    });
    // ============================================================================
    // Expense Attachment Upload
    // ============================================================================
    // Upload a receipt photo / expense invoice image and get back a public URL.
    // The client then stores this URL on the Expense as attachmentUrl.
    // ============================================================================
    fastify.post('/companies/:companyId/uploads/expense-attachment', async (request, reply) => {
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT, Roles.CLERK], 'OWNER/ACCOUNTANT/CLERK');
        const companyId = requireCompanyIdParam(request, reply);
        // @fastify/multipart
        const file = await request.file?.();
        if (!file) {
            reply.status(400);
            return { error: 'file is required (multipart/form-data field: file)' };
        }
        const mimetype = String(file.mimetype ?? '');
        if (!mimetype.startsWith('image/')) {
            reply.status(400);
            return { error: 'only image uploads are allowed' };
        }
        const bucketName = requireEnv('INVOICE_TEMPLATE_ASSETS_BUCKET');
        const storage = new Storage();
        const ext = mimetype === 'image/png' ? '.png' : mimetype === 'image/jpeg' ? '.jpg' : '';
        const objectName = `companies/${companyId}/expense-attachments/${uuidv4()}${ext}`;
        const buf = await file.toBuffer();
        await storage.bucket(bucketName).file(objectName).save(buf, {
            contentType: mimetype,
            resumable: false,
            metadata: {
                cacheControl: 'private, max-age=3600',
            },
        });
        const url = `https://storage.googleapis.com/${bucketName}/${objectName}`;
        return { url };
    });
    const VALID_QR_METHODS = ['kbz', 'ayaPay', 'uabPay', 'aPlus'];
    function sanitizePaymentQrCodes(input) {
        if (!input || typeof input !== 'object')
            return {};
        const result = {};
        for (const key of VALID_QR_METHODS) {
            const val = input[key];
            if (typeof val === 'string' && val.trim()) {
                result[key] = val.trim();
            }
        }
        return result;
    }
    // Get current payment QR codes
    fastify.get('/companies/:companyId/payment-qr-codes', async (request, reply) => {
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER/ACCOUNTANT');
        const companyId = requireCompanyIdParam(request, reply);
        const company = await prisma.company.findUnique({
            where: { id: companyId },
            select: { paymentQrCodes: true },
        });
        return sanitizePaymentQrCodes(company?.paymentQrCodes ?? null);
    });
    // Update payment QR codes (JSON update, not file upload)
    fastify.put('/companies/:companyId/payment-qr-codes', async (request, reply) => {
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER/ACCOUNTANT');
        const companyId = requireCompanyIdParam(request, reply);
        const body = request.body;
        const company = await prisma.company.findUnique({
            where: { id: companyId },
            select: { paymentQrCodes: true },
        });
        const current = sanitizePaymentQrCodes(company?.paymentQrCodes ?? null);
        const merged = { ...current };
        // Merge updates (allow null to clear a method)
        for (const key of VALID_QR_METHODS) {
            if (key in body) {
                const val = body[key];
                if (val === null || val === '') {
                    delete merged[key];
                }
                else if (typeof val === 'string' && val.trim()) {
                    merged[key] = val.trim();
                }
            }
        }
        const updated = await prisma.company.update({
            where: { id: companyId },
            data: { paymentQrCodes: merged },
            select: { paymentQrCodes: true },
        });
        return sanitizePaymentQrCodes(updated.paymentQrCodes ?? null);
    });
    // Upload QR code image for a specific payment method
    fastify.post('/companies/:companyId/payment-qr-codes/:method', async (request, reply) => {
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER/ACCOUNTANT');
        const companyId = requireCompanyIdParam(request, reply);
        const method = String(request.params?.method ?? '').trim();
        if (!VALID_QR_METHODS.includes(method)) {
            reply.status(400);
            return { error: `Invalid method. Valid: ${VALID_QR_METHODS.join(', ')}` };
        }
        const file = await request.file();
        if (!file) {
            reply.status(400);
            return { error: 'file is required' };
        }
        const mimetype = String(file.mimetype ?? '');
        if (!mimetype.startsWith('image/')) {
            reply.status(400);
            return { error: 'only image uploads are allowed' };
        }
        const bucketName = requireEnv('INVOICE_TEMPLATE_ASSETS_BUCKET');
        const storage = new Storage();
        const ext = mimetype === 'image/png' ? '.png' : mimetype === 'image/jpeg' ? '.jpg' : '';
        const objectName = `companies/${companyId}/payment-qr/${method}/${uuidv4()}${ext}`;
        const buf = await file.toBuffer();
        await storage.bucket(bucketName).file(objectName).save(buf, {
            contentType: mimetype,
            metadata: { cacheControl: 'public, max-age=31536000' },
        });
        const publicUrl = `https://storage.googleapis.com/${bucketName}/${objectName}`;
        // Update the specific method's QR code URL
        const company = await prisma.company.findUnique({
            where: { id: companyId },
            select: { paymentQrCodes: true },
        });
        const current = sanitizePaymentQrCodes(company?.paymentQrCodes ?? null);
        current[method] = publicUrl;
        const updated = await prisma.company.update({
            where: { id: companyId },
            data: { paymentQrCodes: current },
            select: { paymentQrCodes: true },
        });
        return {
            method,
            url: publicUrl,
            allQrCodes: sanitizePaymentQrCodes(updated.paymentQrCodes ?? null),
        };
    });
    // Delete a specific payment QR code
    fastify.delete('/companies/:companyId/payment-qr-codes/:method', async (request, reply) => {
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER/ACCOUNTANT');
        const companyId = requireCompanyIdParam(request, reply);
        const method = String(request.params?.method ?? '').trim();
        if (!VALID_QR_METHODS.includes(method)) {
            reply.status(400);
            return { error: `Invalid method. Valid: ${VALID_QR_METHODS.join(', ')}` };
        }
        const company = await prisma.company.findUnique({
            where: { id: companyId },
            select: { paymentQrCodes: true },
        });
        const current = sanitizePaymentQrCodes(company?.paymentQrCodes ?? null);
        delete current[method];
        const updated = await prisma.company.update({
            where: { id: companyId },
            data: { paymentQrCodes: Object.keys(current).length > 0 ? current : Prisma.DbNull },
            select: { paymentQrCodes: true },
        });
        return sanitizePaymentQrCodes(updated.paymentQrCodes ?? null);
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
        function inferReportGroup(code, name, type) {
            const c = String(code ?? '').trim();
            const n = String(name ?? '').trim().toLowerCase();
            if (type === AccountType.ASSET) {
                if (['1000', '1010'].includes(c) || /\b(cash|bank|wallet|e-?wallet)\b/.test(n))
                    return AccountReportGroup.CASH_AND_CASH_EQUIVALENTS;
                if (/receivable/.test(n) || c.startsWith('12'))
                    return AccountReportGroup.ACCOUNTS_RECEIVABLE;
                if (/inventory/.test(n) || c.startsWith('13'))
                    return AccountReportGroup.INVENTORY;
                if (/equipment|furniture|fixture|fixed asset|property|plant/.test(n) || c.startsWith('15'))
                    return AccountReportGroup.FIXED_ASSET;
                return null;
            }
            if (type === AccountType.LIABILITY) {
                if (/payable/.test(n) || c.startsWith('20'))
                    return AccountReportGroup.ACCOUNTS_PAYABLE;
                if (/loan|debt|note payable|mortgage/.test(n) || c.startsWith('25'))
                    return AccountReportGroup.LONG_TERM_LIABILITY;
                return null;
            }
            if (type === AccountType.EQUITY) {
                if (/equity|retained|capital/.test(n) || c.startsWith('30'))
                    return AccountReportGroup.EQUITY;
                return AccountReportGroup.EQUITY;
            }
            return null;
        }
        function inferCashflowActivity(type, reportGroup) {
            // Beginner-friendly defaults:
            // - Fixed assets => Investing
            // - Equity + long-term liabilities => Financing
            // - Everything else => Operating
            if (reportGroup === AccountReportGroup.FIXED_ASSET)
                return CashflowActivity.INVESTING;
            if (reportGroup === AccountReportGroup.LONG_TERM_LIABILITY)
                return CashflowActivity.FINANCING;
            if (type === AccountType.EQUITY)
                return CashflowActivity.FINANCING;
            // We keep INCOME/EXPENSE as OPERATING too (not used for BS deltas, but harmless).
            return CashflowActivity.OPERATING;
        }
        const inferredReportGroup = body.reportGroup ?? inferReportGroup(body.code, body.name, body.type);
        const inferredCashflowActivity = body.cashflowActivity ?? inferCashflowActivity(body.type, inferredReportGroup);
        const account = await prisma.account.create({
            data: {
                companyId,
                code: body.code,
                name: body.name,
                type: body.type,
                normalBalance: normalBalanceForType(body.type),
                reportGroup: inferredReportGroup ?? null,
                cashflowActivity: inferredCashflowActivity ?? null,
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
        function inferReportGroup(code, name, type) {
            const c = String(code ?? '').trim();
            const n = String(name ?? '').trim().toLowerCase();
            if (type === AccountType.ASSET) {
                if (['1000', '1010'].includes(c) || /\b(cash|bank|wallet|e-?wallet)\b/.test(n))
                    return AccountReportGroup.CASH_AND_CASH_EQUIVALENTS;
                if (/receivable/.test(n) || c.startsWith('12'))
                    return AccountReportGroup.ACCOUNTS_RECEIVABLE;
                if (/inventory/.test(n) || c.startsWith('13'))
                    return AccountReportGroup.INVENTORY;
                if (/equipment|furniture|fixture|fixed asset|property|plant/.test(n) || c.startsWith('15'))
                    return AccountReportGroup.FIXED_ASSET;
                return null;
            }
            if (type === AccountType.LIABILITY) {
                if (/payable/.test(n) || c.startsWith('20'))
                    return AccountReportGroup.ACCOUNTS_PAYABLE;
                if (/loan|debt|note payable|mortgage/.test(n) || c.startsWith('25'))
                    return AccountReportGroup.LONG_TERM_LIABILITY;
                return null;
            }
            if (type === AccountType.EQUITY) {
                if (/equity|retained|capital/.test(n) || c.startsWith('30'))
                    return AccountReportGroup.EQUITY;
                return AccountReportGroup.EQUITY;
            }
            return null;
        }
        function inferCashflowActivity(type, reportGroup) {
            if (reportGroup === AccountReportGroup.FIXED_ASSET)
                return CashflowActivity.INVESTING;
            if (reportGroup === AccountReportGroup.LONG_TERM_LIABILITY)
                return CashflowActivity.FINANCING;
            if (type === AccountType.EQUITY)
                return CashflowActivity.FINANCING;
            return CashflowActivity.OPERATING;
        }
        const inferredReportGroup = body.reportGroup ?? inferReportGroup(body.code, body.name, body.type);
        const inferredCashflowActivity = body.cashflowActivity ?? inferCashflowActivity(body.type, inferredReportGroup);
        const account = await prisma.account.create({
            data: {
                companyId,
                code: body.code,
                name: body.name,
                type: body.type,
                normalBalance: normalBalanceForType(body.type),
                reportGroup: inferredReportGroup ?? null,
                cashflowActivity: inferredCashflowActivity ?? null,
            },
        });
        return account;
    });
    // --- Banking accounts (Cash/Bank/E-wallet) ---
    // These are liquidity accounts used for "Deposit To" and for cash/bank movements.
    // They map 1:1 to a Chart of Accounts Account (ASSET).
    fastify.get('/companies/:companyId/banking-accounts', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const company = await prisma.company.findUnique({ where: { id: companyId }, select: { baseCurrency: true } });
        const baseCurrency = (company?.baseCurrency ?? '').trim().toUpperCase() || null;
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
                            currency: baseCurrency,
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
            currency: r.currency ?? null,
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
            currency: banking.currency ?? null,
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
        const currency = body.currency ? String(body.currency).trim().toUpperCase() : null;
        if (currency && !/^[A-Z]{3}$/.test(currency)) {
            reply.status(400);
            return { error: 'currency must be a 3-letter code (e.g. MMK, USD)' };
        }
        const openingBalanceInput = body.openingBalance;
        const openingBalance = openingBalanceInput === undefined ? null : toMoneyDecimal(openingBalanceInput);
        if (openingBalanceInput !== undefined) {
            const n = Number(openingBalanceInput);
            if (!Number.isFinite(n)) {
                reply.status(400);
                return { error: 'openingBalance must be a valid number' };
            }
        }
        // Bank/Cash/E-wallet should be ASSET accounts.
        const created = await prisma.$transaction(async (tx) => {
            const userId = request.user?.userId ?? null;
            const company = await tx.company.findUnique({
                where: { id: companyId },
                select: { openingBalanceEquityAccountId: true },
            });
            const eqId = Number(company?.openingBalanceEquityAccountId ?? 0) || null;
            if (!eqId) {
                throw Object.assign(new Error('company.openingBalanceEquityAccountId is not set'), { statusCode: 400 });
            }
            const eqAcc = await tx.account.findFirst({ where: { id: eqId, companyId }, select: { id: true, type: true } });
            if (!eqAcc || eqAcc.type !== AccountType.EQUITY) {
                throw Object.assign(new Error('openingBalanceEquityAccountId must be an EQUITY account in this company'), {
                    statusCode: 400,
                });
            }
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
                    currency,
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
            // Opening balance posting (optional): Bank/Cash/E-wallet (asset) ↔ Opening Balance Equity.
            // Positive amount => bank asset Dr / equity Cr
            // Negative amount => equity Dr / bank asset Cr (supports overdraft as negative asset)
            if (openingBalance && !openingBalance.equals(0)) {
                const amt = new Prisma.Decimal(openingBalance).toDecimalPlaces(2);
                const abs = amt.abs().toDecimalPlaces(2);
                const lines = amt.greaterThan(0)
                    ? [
                        { accountId: account.id, debit: abs, credit: new Prisma.Decimal(0) },
                        { accountId: eqId, debit: new Prisma.Decimal(0), credit: abs },
                    ]
                    : [
                        { accountId: eqId, debit: abs, credit: new Prisma.Decimal(0) },
                        { accountId: account.id, debit: new Prisma.Decimal(0), credit: abs },
                    ];
                await postJournalEntry(tx, {
                    companyId,
                    date: normalizeToDay(new Date()),
                    description: `Opening balance • Banking: ${String(body.accountName ?? '').trim() || '—'}`,
                    createdByUserId: userId,
                    lines,
                });
            }
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
            currency: created.currency ?? null,
            account: {
                id: created.account.id,
                code: created.account.code,
                name: created.account.name,
                type: created.account.type,
            },
        };
    });
    // Update banking account details + optional opening balance adjustment (posts to GL).
    fastify.put('/companies/:companyId/banking-accounts/:bankingAccountId', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const bankingAccountId = Number(request.params?.bankingAccountId);
        if (Number.isNaN(bankingAccountId)) {
            reply.status(400);
            return { error: 'invalid bankingAccountId' };
        }
        const body = request.body;
        if (!body.accountCode || !body.accountName) {
            reply.status(400);
            return { error: 'accountCode and accountName are required' };
        }
        const currency = body.currency ? String(body.currency).trim().toUpperCase() : null;
        if (currency && !/^[A-Z]{3}$/.test(currency)) {
            reply.status(400);
            return { error: 'currency must be a 3-letter code (e.g. MMK, USD)' };
        }
        const deltaInput = body.openingBalanceDelta;
        const delta = deltaInput === undefined ? null : toMoneyDecimal(deltaInput);
        if (deltaInput !== undefined) {
            const n = Number(deltaInput);
            if (!Number.isFinite(n)) {
                reply.status(400);
                return { error: 'openingBalanceDelta must be a valid number' };
            }
        }
        const userId = request.user?.userId ?? null;
        const updated = await prisma.$transaction(async (tx) => {
            const banking = await tx.bankingAccount.findFirst({
                where: { id: bankingAccountId, companyId },
                include: { account: { select: { id: true, code: true, name: true, type: true } } },
            });
            if (!banking) {
                reply.status(404);
                return { error: 'banking account not found' };
            }
            // Enforce COA account constraints
            if (banking.account.type !== AccountType.ASSET) {
                throw Object.assign(new Error('banking account must map to an ASSET account'), { statusCode: 400 });
            }
            // Account code uniqueness (companyId, code)
            const code = String(body.accountCode).trim();
            if (!code)
                throw Object.assign(new Error('accountCode is required'), { statusCode: 400 });
            const existingCode = await tx.account.findFirst({
                where: { companyId, code, id: { not: banking.account.id } },
                select: { id: true },
            });
            if (existingCode) {
                throw Object.assign(new Error('accountCode must be unique inside your company'), { statusCode: 400 });
            }
            // If primary, unset other primaries
            if (body.isPrimary) {
                await tx.bankingAccount.updateMany({
                    where: { companyId, isPrimary: true, id: { not: bankingAccountId } },
                    data: { isPrimary: false },
                });
            }
            const accRes = await tx.account.updateMany({
                where: { id: banking.account.id, companyId },
                data: { code, name: String(body.accountName).trim() },
            });
            if (accRes?.count !== 1) {
                throw Object.assign(new Error('account not found in this company'), { statusCode: 404 });
            }
            const bankRes = await tx.bankingAccount.updateMany({
                where: { id: banking.id, companyId },
                data: {
                    currency,
                    bankName: body.bankName ?? null,
                    accountNumber: body.accountNumber ?? null,
                    identifierCode: body.identifierCode ?? null,
                    branch: body.branch ?? null,
                    description: body.description ?? null,
                    isPrimary: body.isPrimary ?? false,
                },
            });
            if (bankRes?.count !== 1) {
                throw Object.assign(new Error('banking account not found'), { statusCode: 404 });
            }
            const b2 = await tx.bankingAccount.findFirst({
                where: { id: banking.id, companyId },
                include: { account: { select: { id: true, code: true, name: true, type: true } } },
            });
            if (!b2) {
                throw Object.assign(new Error('banking account not found'), { statusCode: 404 });
            }
            // Optional opening balance adjustment posting
            if (delta && !delta.equals(0)) {
                const company = await tx.company.findUnique({
                    where: { id: companyId },
                    select: { openingBalanceEquityAccountId: true },
                });
                const eqId = Number(company?.openingBalanceEquityAccountId ?? 0) || null;
                if (!eqId) {
                    throw Object.assign(new Error('company.openingBalanceEquityAccountId is not set'), { statusCode: 400 });
                }
                const eqAcc = await tx.account.findFirst({ where: { id: eqId, companyId }, select: { id: true, type: true } });
                if (!eqAcc || eqAcc.type !== AccountType.EQUITY) {
                    throw Object.assign(new Error('openingBalanceEquityAccountId must be an EQUITY account in this company'), {
                        statusCode: 400,
                    });
                }
                const amt = new Prisma.Decimal(delta).toDecimalPlaces(2);
                const abs = amt.abs().toDecimalPlaces(2);
                const lines = amt.greaterThan(0)
                    ? [
                        { accountId: b2.account.id, debit: abs, credit: new Prisma.Decimal(0) },
                        { accountId: eqId, debit: new Prisma.Decimal(0), credit: abs },
                    ]
                    : [
                        { accountId: eqId, debit: abs, credit: new Prisma.Decimal(0) },
                        { accountId: b2.account.id, debit: new Prisma.Decimal(0), credit: abs },
                    ];
                await postJournalEntry(tx, {
                    companyId,
                    date: normalizeToDay(new Date()),
                    description: `Opening balance adjustment • Banking: ${String(b2.account?.name ?? '').trim() || '—'}`,
                    createdByUserId: userId,
                    lines,
                });
            }
            return b2;
        });
        // If reply already sent due to not found inside tx, just return.
        if (updated?.error)
            return updated;
        return {
            id: updated.id,
            kind: updated.kind,
            isPrimary: updated.isPrimary,
            bankName: updated.bankName,
            accountNumber: updated.accountNumber,
            identifierCode: updated.identifierCode,
            branch: updated.branch,
            description: updated.description,
            currency: updated.currency ?? null,
            account: {
                id: updated.account.id,
                code: updated.account.code,
                name: updated.account.name,
                type: updated.account.type,
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