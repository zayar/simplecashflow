/**
 * Cashflow Sale Helper for Pitix Integration
 * 
 * This file integrates with the existing Pitix sale_helper.ts pattern.
 * It hooks into the afterSaleAction flow to sync completed sales to Cashflow.
 * 
 * INSTALLATION:
 *   1. Copy cashflow_client.ts to: app/service/cashflow_client.ts
 *   2. Add this integration to app/graph/pos/sale_helper.ts
 * 
 * @author Cashflow Team
 * @version 1.0.0
 */

import { PrismaClient } from "./client";
import { Sale } from "./generated/type-graphql";
import { getCashflowClient, CashflowSaleRequest, CashflowRefundRequest } from "app/service/cashflow_client";

// ============================================================================
// Configuration
// ============================================================================

/**
 * Check if Cashflow integration is enabled
 */
const isCashflowEnabled = (): boolean => {
  return Boolean(
    process.env.CASHFLOW_INTEGRATION_KEY && 
    process.env.CASHFLOW_COMPANY_ID
  );
};

/**
 * Map Piti payment method to Cashflow account code
 */
const paymentMethodToAccountCode = (paymentMethod: string | null | undefined): string => {
  const method = (paymentMethod ?? "").toLowerCase();
  
  // Map common payment methods to Cashflow account codes
  const mapping: Record<string, string> = {
    "cash": "1000",      // Cash on Hand
    "kbzpay": "1001",    // KBZ Pay (configure in Cashflow)
    "ayapay": "1002",    // AYA Pay
    "wavepay": "1003",   // Wave Pay
    "card": "1010",      // Credit/Debit Card
    "bank": "1020",      // Bank Transfer
  };

  return mapping[method] ?? "1000"; // Default to Cash
};

// ============================================================================
// Sale to Cashflow Request Mapping
// ============================================================================

/**
 * Map a Piti Sale to Cashflow sale request format
 */
const mapSaleToCashflowRequest = (sale: Sale): CashflowSaleRequest => {
  const lines = (sale.items ?? []).map((item: any) => ({
    externalProductId: item.product_id ?? undefined,
    sku: item.sku ?? undefined,
    name: item.product_name ?? item.name ?? "Unknown Item",
    quantity: Number(item.quantity ?? 1),
    unitPrice: Number(item.unit_price ?? item.selling_price ?? 0),
    discountAmount: Number(item.discount_amount ?? 0),
    taxRate: Number(item.tax_rate ?? 0),
  }));

  const request: CashflowSaleRequest = {
    saleId: sale.id,
    saleNumber: sale.sale_number ?? undefined,
    saleDate: sale.sale_date?.toISOString() ?? new Date().toISOString(),
    currency: "MMK", // Default currency

    customer: sale.customer ? {
      externalCustomerId: sale.customer.id ?? undefined,
      name: sale.customer.name ?? "Walk-in Customer",
      phone: sale.customer.phone ?? null,
      email: sale.customer.email ?? null,
    } : {
      name: "Walk-in Customer",
    },

    lines,

    // Include payment if sale is paid
    payments: sale.payment_status === "PAID" ? [{
      cashflowAccountCode: paymentMethodToAccountCode(sale.payment_method),
      amount: Number(sale.net_amount ?? sale.gross_amount ?? 0),
      paidAt: sale.sale_date?.toISOString() ?? new Date().toISOString(),
    }] : undefined,

    options: {
      autoCreateCustomer: true,
      autoCreateItems: true,
      recordPayment: sale.payment_status === "PAID",
    },
  };

  return request;
};

/**
 * Map a Piti Sale (refund/cancellation) to Cashflow refund request format
 */
const mapRefundToCashflowRequest = (sale: Sale): CashflowRefundRequest => {
  const lines = (sale.items ?? []).map((item: any) => ({
    externalProductId: item.product_id ?? undefined,
    sku: item.sku ?? undefined,
    name: item.product_name ?? item.name ?? "Unknown Item",
    quantity: Number(item.quantity ?? 1),
    unitPrice: Number(item.unit_price ?? item.selling_price ?? 0),
    discountAmount: Number(item.discount_amount ?? 0),
    taxRate: Number(item.tax_rate ?? 0),
  }));

  return {
    refundId: `${sale.id}_refund`,
    saleId: sale.id, // Link to original sale
    refundNumber: `RF-${sale.sale_number}`,
    refundDate: new Date().toISOString(),
    currency: "MMK",

    customer: sale.customer ? {
      externalCustomerId: sale.customer.id ?? undefined,
      name: sale.customer.name ?? "Walk-in Customer",
      phone: sale.customer.phone ?? null,
      email: sale.customer.email ?? null,
    } : {
      name: "Walk-in Customer",
    },

    lines,
  };
};

// ============================================================================
// Integration Functions
// ============================================================================

/**
 * Sync a completed sale to Cashflow
 * Call this after a sale is completed (in afterSaleAction or trigger)
 * 
 * @example
 * ```ts
 * // In sale_helper.ts afterSaleAction:
 * const afterSaleAction = async (tx: PrismaClient, sale: Sale, env: string) => {
 *   await useCoupon(tx, sale, env);
 *   await usePoint(tx, sale, env);
 *   
 *   // Add Cashflow sync
 *   if (sale.sale_status === "COMPLETED") {
 *     await syncSaleToCashflow(sale, env);
 *   }
 * };
 * ```
 */
export const syncSaleToCashflow = async (
  sale: Sale, 
  env: string
): Promise<void> => {
  if (!isCashflowEnabled()) {
    console.log("[Cashflow] Integration not enabled, skipping sync");
    return;
  }

  if (sale.sale_status !== "COMPLETED") {
    console.log(`[Cashflow] Sale ${sale.sale_number} not completed, skipping sync`);
    return;
  }

  try {
    const client = getCashflowClient(env as any);
    const request = mapSaleToCashflowRequest(sale);

    console.log(`[Cashflow] Syncing sale ${sale.sale_number} to Cashflow...`);
    const result = await client.importSale(request);

    console.log(
      `[Cashflow] Sale synced successfully:`,
      JSON.stringify({
        saleId: sale.id,
        saleNumber: sale.sale_number,
        invoiceId: result.invoiceId,
        invoiceNumber: result.invoiceNumber,
        status: result.invoiceStatus,
      })
    );
  } catch (error: any) {
    // Log error but don't throw - we don't want to break the sale flow
    console.error(
      `[Cashflow] Failed to sync sale ${sale.sale_number}:`,
      error.message
    );
    
    // Optionally: Queue for retry or alert
    // await queueForRetry(sale, "sale", error.message);
  }
};

/**
 * Sync a canceled/refunded sale to Cashflow
 * Call this when a sale is canceled (in cancelSaleAction or trigger)
 * 
 * @example
 * ```ts
 * // In sale_helper.ts cancelSaleAction:
 * const cancelSaleAction = async (tx: PrismaClient, sale: Sale, env: string) => {
 *   await refundPoint(tx, sale, env);
 *   
 *   // Add Cashflow refund sync
 *   await syncRefundToCashflow(sale, env);
 * };
 * ```
 */
export const syncRefundToCashflow = async (
  sale: Sale,
  env: string
): Promise<void> => {
  if (!isCashflowEnabled()) {
    console.log("[Cashflow] Integration not enabled, skipping refund sync");
    return;
  }

  try {
    const client = getCashflowClient(env as any);
    const request = mapRefundToCashflowRequest(sale);

    console.log(`[Cashflow] Syncing refund for sale ${sale.sale_number}...`);
    const result = await client.importRefund(request);

    console.log(
      `[Cashflow] Refund synced successfully:`,
      JSON.stringify({
        saleId: sale.id,
        saleNumber: sale.sale_number,
        creditNoteId: result.creditNoteId,
        creditNoteNumber: result.creditNoteNumber,
        status: result.status,
      })
    );
  } catch (error: any) {
    console.error(
      `[Cashflow] Failed to sync refund for sale ${sale.sale_number}:`,
      error.message
    );
  }
};

/**
 * Sync payment received to Cashflow
 * Call this when a payment is received for a pending sale
 */
export const syncPaymentToCashflow = async (
  saleId: string,
  amount: number,
  paymentMethod: string,
  env: string
): Promise<void> => {
  if (!isCashflowEnabled()) {
    return;
  }

  // For payment-only syncs, we'd need an additional endpoint in Cashflow
  // For now, the payment is included when the sale is synced
  console.log(
    `[Cashflow] Payment sync requested for sale ${saleId}:`,
    JSON.stringify({ amount, paymentMethod })
  );
};

// ============================================================================
// Export for use in sale_helper.ts
// ============================================================================

export const cashflowHelper = {
  syncSaleToCashflow,
  syncRefundToCashflow,
  syncPaymentToCashflow,
  isCashflowEnabled,
};

export default cashflowHelper;

