import type { FastifyInstance } from 'fastify';
import { prisma } from '../../infrastructure/db.js';

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
        company: { select: { name: true, timeZone: true, invoiceTemplate: true } },
      },
    });

    if (!invoice) {
      reply.status(404);
      return { error: 'invoice not found' };
    }

    const totalPaid = Number(invoice.amountPaid ?? 0);
    const remainingBalance = Math.max(0, Number(invoice.total ?? 0) - totalPaid);

    return {
      company: {
        id: companyId,
        name: invoice.company.name,
        timeZone: invoice.company.timeZone ?? null,
        template: sanitizeInvoiceTemplate((invoice.company as any).invoiceTemplate ?? null),
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
}


