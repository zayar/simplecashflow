import type { FastifyInstance } from 'fastify';
import { prisma } from '../../infrastructure/db.js';
import { Storage } from '@google-cloud/storage';
import { v4 as uuidv4 } from 'uuid';

type StoredPaymentProofV1 =
  | { url: string; submittedAt?: string; note?: string | null } // legacy (public URL)
  | { id: string; gcsUri: string; submittedAt?: string; note?: string | null }; // v1 private storage reference

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

function parseGcsUri(input: string): { bucket: string; objectName: string } | null {
  const s = String(input ?? '').trim();
  if (!s.startsWith('gs://')) return null;
  const rest = s.slice('gs://'.length);
  const idx = rest.indexOf('/');
  if (idx <= 0) return null;
  const bucket = rest.slice(0, idx);
  const objectName = rest.slice(idx + 1);
  if (!bucket || !objectName) return null;
  return { bucket, objectName };
}

async function signedUrlForGcsUri(storage: Storage, gcsUri: string, ttlMs: number): Promise<string | null> {
  const parsed = parseGcsUri(gcsUri);
  if (!parsed) return null;
  try {
    const [url] = await storage.bucket(parsed.bucket).file(parsed.objectName).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + ttlMs,
    });
    return url;
  } catch {
    return null;
  }
}

function originFromRequest(request: any): string {
  const protoRaw = String((request?.headers as any)?.['x-forwarded-proto'] ?? 'https');
  const proto = (protoRaw.split(',')[0] || 'https').trim();
  const hostRaw = String((request?.headers as any)?.['x-forwarded-host'] ?? request?.headers?.host ?? '');
  const host = (hostRaw.split(',')[0] || '').trim();
  return host ? `${proto}://${host}` : '';
}

function guessContentTypeFromObjectName(objectName: string): string {
  const s = String(objectName ?? '').toLowerCase();
  if (s.endsWith('.png')) return 'image/png';
  if (s.endsWith('.jpg') || s.endsWith('.jpeg')) return 'image/jpeg';
  if (s.endsWith('.gif')) return 'image/gif';
  if (s.endsWith('.webp')) return 'image/webp';
  return 'application/octet-stream';
}

async function presentPaymentProofs(
  storage: Storage,
  proofs: any,
  opts?: { signedUrlTtlMs?: number; request?: any; token?: string }
): Promise<Array<{ id?: string; url: string; submittedAt: string | null; note: string | null }>> {
  const ttlMs = Number(opts?.signedUrlTtlMs ?? 15 * 60 * 1000); // 15 minutes
  if (!Array.isArray(proofs)) return [];

  const out: Array<{ id?: string; url: string; submittedAt: string | null; note: string | null }> = [];
  for (const p of proofs as StoredPaymentProofV1[]) {
    const submittedAt = typeof (p as any)?.submittedAt === 'string' ? (p as any).submittedAt : null;
    const note = typeof (p as any)?.note === 'string' ? (p as any).note : (p as any)?.note === null ? null : null;

    // New format: private object reference (signed URL on demand)
    if (typeof (p as any)?.gcsUri === 'string' && typeof (p as any)?.id === 'string') {
      const origin = originFromRequest(opts?.request);
      const token = String(opts?.token ?? '').trim();
      const id = String((p as any).id);
      const publicUrl =
        origin && token ? `${origin}/public/invoices/${encodeURIComponent(token)}/payment-proof/${encodeURIComponent(id)}` : null;
      const url = publicUrl ?? (await signedUrlForGcsUri(storage, String((p as any).gcsUri), ttlMs));
      if (url) out.push({ id, url, submittedAt, note });
      continue;
    }

    // Legacy format: public URL stored directly
    if (typeof (p as any)?.url === 'string' && String((p as any).url).trim()) {
      out.push({ url: String((p as any).url).trim(), submittedAt, note });
    }
  }
  return out;
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

    // Payment proofs: support both legacy public URLs and new private proofs via signed URLs.
    const storage = new Storage();
    const pendingPaymentProofs = await presentPaymentProofs(storage, (invoice as any).pendingPaymentProofs, { request, token });

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

  // Private access to a single payment proof image via short-lived token.
  // This avoids relying on GCS signed URL generation (which can be blocked by IAM policy),
  // while still keeping the object private in GCS.
  fastify.get('/private/invoice-payment-proofs/:token', async (request, reply) => {
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
      return { error: 'invalid or expired token' };
    }

    if (!payload || typeof payload !== 'object' || payload.typ !== 'invoice_payment_proof') {
      reply.status(404);
      return { error: 'invalid or expired token' };
    }

    const companyId = Number(payload.companyId ?? 0);
    const invoiceId = Number(payload.invoiceId ?? 0);
    const proofId = String(payload.proofId ?? '').trim();
    if (!Number.isInteger(companyId) || companyId <= 0 || !Number.isInteger(invoiceId) || invoiceId <= 0 || !proofId) {
      reply.status(404);
      return { error: 'invalid or expired token' };
    }

    const inv = await prisma.invoice.findFirst({
      where: { id: invoiceId, companyId },
      select: { pendingPaymentProofs: true },
    });
    if (!inv) {
      reply.status(404);
      return { error: 'invoice not found' };
    }

    const proofs = Array.isArray((inv as any).pendingPaymentProofs) ? ((inv as any).pendingPaymentProofs as any[]) : [];
    const hit = proofs.find((p: any) => String(p?.id ?? '') === proofId) ?? null;
    if (!hit) {
      reply.status(404);
      return { error: 'payment proof not found' };
    }

    // Legacy public URL: redirect
    if (typeof hit?.url === 'string' && String(hit.url).trim()) {
      reply.redirect(String(hit.url).trim());
      return;
    }

    const gcsUri = typeof hit?.gcsUri === 'string' ? String(hit.gcsUri).trim() : '';
    const parsed = parseGcsUri(gcsUri);
    if (!parsed) {
      reply.status(404);
      return { error: 'payment proof not found' };
    }

    const storage = new Storage();
    const file = storage.bucket(parsed.bucket).file(parsed.objectName);
    reply.header('Cache-Control', 'private, max-age=900');
    reply.type(guessContentTypeFromObjectName(parsed.objectName));

    return await reply.send(file.createReadStream());
  });

  // Public view of a single payment proof image (requires the same invoice_public token).
  fastify.get('/public/invoices/:token/payment-proof/:proofId', async (request, reply) => {
    const token = String((request.params as any)?.token ?? '').trim();
    const proofId = String((request.params as any)?.proofId ?? '').trim();
    if (!token || !proofId) {
      reply.status(400);
      return { error: 'token and proofId are required' };
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

    const inv = await prisma.invoice.findFirst({
      where: { id: invoiceId, companyId },
      select: { pendingPaymentProofs: true },
    });
    if (!inv) {
      reply.status(404);
      return { error: 'invoice not found' };
    }

    const proofs = Array.isArray((inv as any).pendingPaymentProofs) ? ((inv as any).pendingPaymentProofs as any[]) : [];
    const hit = proofs.find((p: any) => String(p?.id ?? '') === proofId) ?? null;
    if (!hit) {
      reply.status(404);
      return { error: 'payment proof not found' };
    }

    // Legacy public URL: redirect
    if (typeof hit?.url === 'string' && String(hit.url).trim()) {
      reply.redirect(String(hit.url).trim());
      return;
    }

    const gcsUri = typeof hit?.gcsUri === 'string' ? String(hit.gcsUri).trim() : '';
    const parsed = parseGcsUri(gcsUri);
    if (!parsed) {
      reply.status(404);
      return { error: 'payment proof not found' };
    }

    const storage = new Storage();
    const file = storage.bucket(parsed.bucket).file(parsed.objectName);
    reply.header('Cache-Control', 'private, max-age=900');
    reply.type(guessContentTypeFromObjectName(parsed.objectName));
    return await reply.send(file.createReadStream());
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
      select: { id: true, status: true, amountPaid: true, pendingPaymentProofs: true },
    });
    if (!invoice) {
      reply.status(404);
      return { error: 'invoice not found' };
    }
    const paid = Number((invoice as any).amountPaid ?? 0);
    if (paid > 0 || invoice.status === 'PARTIAL' || invoice.status === 'PAID' || invoice.status === 'VOID') {
      reply.status(400);
      return { error: 'payment proof can only be changed before the business records payment' };
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

    // Upload to GCS (PRIVATE bucket preferred for payment proofs)
    const bucketName = process.env.PAYMENT_PROOF_BUCKET || process.env.INVOICE_TEMPLATE_ASSETS_BUCKET;
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
      resumable: false,
      metadata: { cacheControl: 'private, max-age=3600' },
    });

    // Get body for optional note
    const body = (request.body ?? {}) as { note?: string };
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : null;

    const proofId = uuidv4();
    const gcsUri = `gs://${bucketName}/${objectName}`;

    const newProof = {
      id: proofId,
      gcsUri,
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

    const presented = await presentPaymentProofs(storage, [...existingProofs, newProof], { request, token });
    const presentedOne = presented.find((p) => p.id === proofId) ?? null;

    return {
      success: true,
      message: 'Payment proof uploaded. The business will review and confirm your payment.',
      proof: presentedOne ?? { id: proofId, url: '', submittedAt: newProof.submittedAt, note: newProof.note },
      pendingPaymentProofs: presented,
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
    const id = typeof (request.query as any)?.id === 'string' ? String((request.query as any).id) : null;

    const invoice = await prisma.invoice.findFirst({
      where: { id: invoiceId, companyId },
      select: { status: true, amountPaid: true, pendingPaymentProofs: true },
    });
    if (!invoice) {
      reply.status(404);
      return { error: 'invoice not found' };
    }
    const paid = Number((invoice as any).amountPaid ?? 0);
    if (paid > 0 || invoice.status === 'PARTIAL' || invoice.status === 'PAID' || invoice.status === 'VOID') {
      reply.status(400);
      return { error: 'payment proof can only be changed before the business records payment' };
    }

    const existing = Array.isArray(invoice.pendingPaymentProofs) ? (invoice.pendingPaymentProofs as any[]) : [];

    // Determine which proofs to remove (by id preferred; legacy by url)
    const removeAll = !id && !url;
    const toRemove = removeAll
      ? existing
      : id
        ? existing.filter((p: any) => String(p?.id ?? '') === id)
        : url
          ? existing.filter((p: any) => String(p?.url ?? '') === url)
          : [];

    const next = removeAll
      ? []
      : id
        ? existing.filter((p: any) => String(p?.id ?? '') !== id)
        : url
          ? existing.filter((p: any) => String(p?.url ?? '') !== url)
          : existing;

    // Best-effort delete objects for new-format proofs (gs://...)
    const storage = new Storage();
    for (const p of toRemove as StoredPaymentProofV1[]) {
      const gcsUri = typeof (p as any)?.gcsUri === 'string' ? String((p as any).gcsUri) : null;
      const parsed = gcsUri ? parseGcsUri(gcsUri) : null;
      if (parsed) {
        try {
          await storage.bucket(parsed.bucket).file(parsed.objectName).delete({ ignoreNotFound: true });
        } catch {
          // best-effort
        }
      }
    }

    await prisma.invoice.updateMany({
      where: { id: invoiceId, companyId },
      data: { pendingPaymentProofs: next as any },
    });

    const presented = await presentPaymentProofs(storage, next, { request, token });
    return { success: true, pendingPaymentProofs: presented };
  });
}


