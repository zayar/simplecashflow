import type { FastifyInstance } from 'fastify';
import { prisma } from '../../infrastructure/db.js';
import { Storage } from '@google-cloud/storage';
import { v4 as uuidv4 } from 'uuid';

type InvoiceTemplateV1 = {
  version: 1;
  logoUrl: string | null;
  accentColor: string;
  fontFamily: string;
  headerText: string | null;
  footerText: string | null;
  tableHeaderBg: string;
  tableHeaderText: string;
};

const DEFAULT_INVOICE_TEMPLATE: InvoiceTemplateV1 = {
  version: 1,
  logoUrl: null,
  accentColor: '#2F81B7',
  fontFamily: 'Inter',
  headerText: null,
  footerText: null,
  tableHeaderBg: '#2F81B7',
  tableHeaderText: '#FFFFFF',
};

function isHexColor(s: string): boolean {
  const v = String(s ?? '').trim();
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v);
}

function sanitizeInvoiceTemplate(input: any): InvoiceTemplateV1 {
  const obj = input && typeof input === 'object' ? input : {};

  const logoUrl =
    typeof obj.logoUrl === 'string' && obj.logoUrl.trim()
      ? obj.logoUrl.trim()
      : obj.logoUrl === null
        ? null
        : DEFAULT_INVOICE_TEMPLATE.logoUrl;

  const accentColor =
    typeof obj.accentColor === 'string' && isHexColor(obj.accentColor)
      ? obj.accentColor.toUpperCase()
      : DEFAULT_INVOICE_TEMPLATE.accentColor;

  const tableHeaderBg =
    typeof obj.tableHeaderBg === 'string' && isHexColor(obj.tableHeaderBg)
      ? obj.tableHeaderBg.toUpperCase()
      : accentColor;

  const tableHeaderText =
    typeof obj.tableHeaderText === 'string' && isHexColor(obj.tableHeaderText)
      ? obj.tableHeaderText.toUpperCase()
      : DEFAULT_INVOICE_TEMPLATE.tableHeaderText;

  const fontFamily =
    typeof obj.fontFamily === 'string' && obj.fontFamily.trim()
      ? obj.fontFamily.trim()
      : DEFAULT_INVOICE_TEMPLATE.fontFamily;

  const headerText =
    typeof obj.headerText === 'string' ? obj.headerText : obj.headerText === null ? null : DEFAULT_INVOICE_TEMPLATE.headerText;
  const footerText =
    typeof obj.footerText === 'string' ? obj.footerText : obj.footerText === null ? null : DEFAULT_INVOICE_TEMPLATE.footerText;

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

export async function invoicePublicRoutes(fastify: FastifyInstance) {
  // Public invoice view: customer does NOT need to login.
  fastify.get('/public/invoices/:token', async (request, reply) => {
    const token = String((request.params as any)?.token ?? '').trim();
    if (!token) {
      reply.status(400);
      return { error: 'token is required' };
    }

    let payload: any;
    try {
      payload = fastify.jwt.verify(token);
    } catch {
      reply.status(404);
      return { error: 'invalid or expired link' };
    }

    if (!payload || typeof payload !== 'object' || payload.typ !== 'invoice_public') {
      reply.status(404);
      return { error: 'invalid or expired link' };
    }

    const companyId = Number(payload.companyId ?? 0);
    const invoiceId = Number(payload.invoiceId ?? 0);
    if (!Number.isInteger(companyId) || companyId <= 0 || !Number.isInteger(invoiceId) || invoiceId <= 0) {
      reply.status(404);
      return { error: 'invalid or expired link' };
    }

    const invoice = await prisma.invoice.findFirst({
      where: { id: invoiceId, companyId },
      select: {
        id: true,
        invoiceNumber: true,
        status: true,
        invoiceDate: true,
        dueDate: true,
        currency: true,
        subtotal: true,
        taxAmount: true,
        total: true,
        amountPaid: true,
        customerNotes: true,
        termsAndConditions: true,
        pendingPaymentProofs: true,
        customer: { select: { name: true } },
        location: { select: { name: true } },
        lines: {
          select: {
            id: true,
            quantity: true,
            unitPrice: true,
            discountAmount: true,
            description: true,
            item: { select: { name: true } },
          },
        },
        company: { select: { name: true, timeZone: true, invoiceTemplate: true, paymentQrCodes: true } },
      },
    });

    if (!invoice) {
      reply.status(404);
      return { error: 'invoice not found' };
    }

    const totalPaid = Number(invoice.amountPaid ?? 0);
    const remainingBalance = Math.max(0, Number(invoice.total ?? 0) - totalPaid);

    // Sanitize payment QR codes (canonical keys used by web app + backend settings)
    const paymentQrCodes = (invoice.company as any).paymentQrCodes ?? {};
    const qrCodes: Record<string, string | null> = {};
    for (const key of ['kbz', 'ayaPay', 'uabPay', 'aPlus']) {
      const val = (paymentQrCodes as any)?.[key];
      qrCodes[key] = typeof val === 'string' && val.trim() ? val.trim() : null;
    }

    // Sanitize pending payment proofs (customer-uploaded screenshots)
    const pendingPaymentProofs = Array.isArray((invoice as any).pendingPaymentProofs)
      ? (invoice as any).pendingPaymentProofs
          .map((p: any) => ({
            url: typeof p?.url === 'string' ? p.url : null,
            submittedAt: typeof p?.submittedAt === 'string' ? p.submittedAt : null,
            note: typeof p?.note === 'string' ? p.note : p?.note === null ? null : null,
          }))
          .filter((p: any) => typeof p.url === 'string' && p.url)
      : [];

    return {
      company: {
        id: companyId,
        name: invoice.company.name,
        timeZone: invoice.company.timeZone ?? null,
        template: sanitizeInvoiceTemplate((invoice.company as any).invoiceTemplate ?? null),
        paymentQrCodes: qrCodes,
      },
      invoice: {
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        status: invoice.status,
        invoiceDate: invoice.invoiceDate,
        dueDate: invoice.dueDate ?? null,
        currency: invoice.currency ?? null,
        subtotal: invoice.subtotal,
        taxAmount: invoice.taxAmount,
        total: invoice.total,
        totalPaid,
        remainingBalance,
        customerName: invoice.customer?.name ?? null,
        locationName: invoice.location?.name ?? null,
        customerNotes: invoice.customerNotes ?? null,
        termsAndConditions: invoice.termsAndConditions ?? null,
        pendingPaymentProofs,
        lines: (invoice.lines ?? []).map((l: any) => ({
          id: l.id,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          discountAmount: l.discountAmount,
          description: l.description ?? null,
          itemName: l.item?.name ?? null,
        })),
      },
    };
  });

  // ============================================================================
  // Customer Payment Proof Upload (Public, No Auth Required)
  // ============================================================================
  // Customer can upload a payment screenshot after making payment via KBZ/AYA Pay.
  // The proof is stored in pendingPaymentProofs on the Invoice and the owner
  // can review + record the payment with the attachment.
  // ============================================================================
  fastify.post('/public/invoices/:token/payment-proof', async (request, reply) => {
    const token = String((request.params as any)?.token ?? '').trim();
    if (!token) {
      reply.status(400);
      return { error: 'token is required' };
    }

    let payload: any;
    try {
      payload = fastify.jwt.verify(token);
    } catch {
      reply.status(404);
      return { error: 'invalid or expired link' };
    }

    if (!payload || typeof payload !== 'object' || payload.typ !== 'invoice_public') {
      reply.status(404);
      return { error: 'invalid or expired link' };
    }

    const companyId = Number(payload.companyId ?? 0);
    const invoiceId = Number(payload.invoiceId ?? 0);
    if (!Number.isInteger(companyId) || companyId <= 0 || !Number.isInteger(invoiceId) || invoiceId <= 0) {
      reply.status(404);
      return { error: 'invalid or expired link' };
    }

    // Verify invoice exists and is in a state that can receive payment proofs
    const invoice = await prisma.invoice.findFirst({
      where: { id: invoiceId, companyId },
      select: { id: true, status: true, pendingPaymentProofs: true },
    });
    if (!invoice) {
      reply.status(404);
      return { error: 'invoice not found' };
    }
    if (invoice.status === 'PAID' || invoice.status === 'VOID') {
      reply.status(400);
      return { error: 'this invoice is already paid or voided' };
    }

    // Get uploaded file
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

    // Upload to GCS
    const bucketName = process.env.INVOICE_TEMPLATE_ASSETS_BUCKET;
    if (!bucketName) {
      reply.status(500);
      return { error: 'storage not configured' };
    }

    const storage = new Storage();
    const ext = mimetype === 'image/png' ? '.png' : mimetype === 'image/jpeg' ? '.jpg' : '.img';
    const objectName = `companies/${companyId}/payment-proofs/${invoiceId}/${uuidv4()}${ext}`;

    const buf: Buffer = await file.toBuffer();
    await storage.bucket(bucketName).file(objectName).save(buf, {
      contentType: mimetype,
      metadata: { cacheControl: 'public, max-age=31536000' },
    });

    const publicUrl = `https://storage.googleapis.com/${bucketName}/${objectName}`;

    // Get body for optional note
    const body = (request.body ?? {}) as { note?: string };
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : null;

    const newProof = {
      url: publicUrl,
      submittedAt: new Date().toISOString(),
      note: note || null,
    };

    const existingProofs = Array.isArray(invoice.pendingPaymentProofs)
      ? (invoice.pendingPaymentProofs as any[])
      : [];

    // Limit to 5 proofs per invoice to prevent abuse
    if (existingProofs.length >= 5) {
      reply.status(400);
      return { error: 'maximum 5 payment proofs per invoice' };
    }

    await prisma.invoice.updateMany({
      where: { id: invoiceId, companyId },
      data: {
        pendingPaymentProofs: [...existingProofs, newProof],
      },
    });

    return {
      success: true,
      message: 'Payment proof uploaded. The business will review and confirm your payment.',
      proof: newProof,
      pendingPaymentProofs: [...existingProofs, newProof],
    };
  });

  // Delete one (or all) payment proofs uploaded by customer via public link.
  fastify.delete('/public/invoices/:token/payment-proof', async (request, reply) => {
    const token = String((request.params as any)?.token ?? '').trim();
    if (!token) {
      reply.status(400);
      return { error: 'token is required' };
    }

    let payload: any;
    try {
      payload = fastify.jwt.verify(token);
    } catch {
      reply.status(404);
      return { error: 'invalid or expired link' };
    }

    if (!payload || typeof payload !== 'object' || payload.typ !== 'invoice_public') {
      reply.status(404);
      return { error: 'invalid or expired link' };
    }

    const companyId = Number(payload.companyId ?? 0);
    const invoiceId = Number(payload.invoiceId ?? 0);
    if (!Number.isInteger(companyId) || companyId <= 0 || !Number.isInteger(invoiceId) || invoiceId <= 0) {
      reply.status(404);
      return { error: 'invalid or expired link' };
    }

    const url = typeof (request.query as any)?.url === 'string' ? String((request.query as any).url) : null;

    const invoice = await prisma.invoice.findFirst({
      where: { id: invoiceId, companyId },
      select: { status: true, pendingPaymentProofs: true },
    });
    if (!invoice) {
      reply.status(404);
      return { error: 'invoice not found' };
    }
    if (invoice.status === 'PAID' || invoice.status === 'VOID') {
      reply.status(400);
      return { error: 'this invoice is already paid or voided' };
    }

    const existing = Array.isArray(invoice.pendingPaymentProofs) ? (invoice.pendingPaymentProofs as any[]) : [];
    const next = url ? existing.filter((p: any) => p?.url !== url) : [];

    await prisma.invoice.updateMany({
      where: { id: invoiceId, companyId },
      data: { pendingPaymentProofs: next as any },
    });

    return { success: true, pendingPaymentProofs: next };
  });
}


