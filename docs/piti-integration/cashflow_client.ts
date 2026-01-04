/**
 * Cashflow API Client for Pitix Integration
 * 
 * This file provides a ready-to-use client for integrating Pitix POS with Cashflow finance system.
 * 
 * INSTALLATION:
 *   Copy this file to: app/service/cashflow_client.ts
 * 
 * CONFIGURATION (env variables):
 *   - CASHFLOW_API_URL: The Cashflow API base URL (production or staging)
 *   - CASHFLOW_INTEGRATION_KEY: The shared secret API key
 *   - CASHFLOW_COMPANY_ID: The Cashflow company ID for this business
 * 
 * @author Cashflow Team
 * @version 1.0.0
 */

import axios, { AxiosInstance, AxiosError } from "axios";
import { AppENV } from "../interface";

// ============================================================================
// Types
// ============================================================================

export interface CashflowSaleRequest {
  /** Piti sale ID (unique per sale) */
  saleId: string;
  /** Piti sale number (human-readable) */
  saleNumber?: string;
  /** Sale date (ISO 8601) */
  saleDate?: string;
  /** Currency code (e.g., "MMK") */
  currency?: string;

  /** Customer info (optional) */
  customer?: {
    externalCustomerId?: string;
    name: string;
    phone?: string | null;
    email?: string | null;
  } | null;

  /** Line items (required, at least one) */
  lines: Array<{
    /** Piti product ID */
    externalProductId?: string;
    /** Product SKU */
    sku?: string | null;
    /** Product name (for auto-creation) */
    name: string;
    /** Quantity sold */
    quantity: number;
    /** Unit price */
    unitPrice: number;
    /** Discount amount (total for this line) */
    discountAmount?: number | null;
    /** Tax rate as decimal (0.05 = 5%) */
    taxRate?: number | null;
  }>;

  /** Payments (optional - include if sale is already paid) */
  payments?: Array<{
    /** Cashflow account code (e.g., "1000" for Cash) */
    cashflowAccountCode?: string;
    /** Payment amount */
    amount: number;
    /** Payment date (ISO 8601) */
    paidAt?: string;
  }> | null;

  /** Options (optional) */
  options?: {
    autoCreateCustomer?: boolean;
    autoCreateItems?: boolean;
    postInvoice?: boolean;
    recordPayment?: boolean;
  };
}

export interface CashflowSaleResponse {
  saleId: string;
  invoiceId: number;
  invoiceNumber: string;
  invoiceStatus: string;
  journalEntryId: number | null;
  paymentIds: number[];
}

export interface CashflowRefundRequest {
  /** Piti refund ID (unique per refund) */
  refundId: string;
  /** Original sale ID (for linking) */
  saleId?: string | null;
  /** Refund number (human-readable) */
  refundNumber?: string;
  /** Refund date (ISO 8601) */
  refundDate?: string;
  /** Currency code */
  currency?: string;

  /** Customer info */
  customer?: {
    externalCustomerId?: string;
    name: string;
    phone?: string | null;
    email?: string | null;
  } | null;

  /** Refunded line items */
  lines: Array<{
    externalProductId?: string;
    sku?: string | null;
    name: string;
    quantity: number;
    unitPrice: number;
    discountAmount?: number | null;
    taxRate?: number | null;
  }>;
}

export interface CashflowRefundResponse {
  refundId: string;
  creditNoteId: number;
  creditNoteNumber: string;
  status: string;
  journalEntryId: number | null;
}

export interface CashflowError {
  error: string;
}

export interface CashflowClientConfig {
  apiUrl: string;
  integrationKey: string;
  companyId: string | number;
  env?: AppENV;
}

// ============================================================================
// Environment Configuration
// ============================================================================

const getEnvConfig = (env: AppENV): { apiUrl: string } => {
  switch (env) {
    case "prod":
      return {
        apiUrl: process.env.CASHFLOW_API_URL_PROD || 
                "https://cashflow-api-291129507535.asia-southeast1.run.app",
      };
    case "dev":
    default:
      return {
        apiUrl: process.env.CASHFLOW_API_URL_DEV || 
                process.env.CASHFLOW_API_URL ||
                "http://localhost:8080",
      };
  }
};

// ============================================================================
// Retry Logic
// ============================================================================

interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 5,
  baseDelayMs: 1000,
  maxDelayMs: 60000,
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const shouldRetry = (error: AxiosError): boolean => {
  // Retry on network errors
  if (!error.response) return true;
  
  const status = error.response.status;
  // Retry on 429 (rate limit) and 5xx (server errors)
  return status === 429 || status >= 500;
};

const calculateDelay = (attempt: number, config: RetryConfig): number => {
  // Exponential backoff: 1s, 2s, 4s, 8s, 16s, ...
  const delay = config.baseDelayMs * Math.pow(2, attempt);
  return Math.min(delay, config.maxDelayMs);
};

// ============================================================================
// Cashflow API Client
// ============================================================================

export class CashflowClient {
  private client: AxiosInstance;
  private companyId: string;
  private integrationKey: string;
  private retryConfig: RetryConfig;

  constructor(config: CashflowClientConfig, retryConfig?: Partial<RetryConfig>) {
    this.companyId = String(config.companyId);
    this.integrationKey = config.integrationKey;
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };

    this.client = axios.create({
      baseURL: config.apiUrl,
      timeout: 30000,
      headers: {
        "Content-Type": "application/json",
        "X-Integration-Key": this.integrationKey,
      },
    });
  }

  /**
   * Create a CashflowClient from environment variables
   */
  static fromEnv(env: AppENV = "dev"): CashflowClient {
    const envConfig = getEnvConfig(env);
    
    const integrationKey = process.env.CASHFLOW_INTEGRATION_KEY;
    if (!integrationKey) {
      throw new Error("CASHFLOW_INTEGRATION_KEY environment variable is required");
    }

    const companyId = process.env.CASHFLOW_COMPANY_ID;
    if (!companyId) {
      throw new Error("CASHFLOW_COMPANY_ID environment variable is required");
    }

    return new CashflowClient({
      apiUrl: envConfig.apiUrl,
      integrationKey,
      companyId,
      env,
    });
  }

  /**
   * Generate idempotency key for sale
   */
  private saleIdempotencyKey(saleId: string): string {
    return `piti:sale:${saleId}:completed`;
  }

  /**
   * Generate idempotency key for refund
   */
  private refundIdempotencyKey(refundId: string): string {
    return `piti:refund:${refundId}`;
  }

  /**
   * Execute request with retry logic
   */
  private async executeWithRetry<T>(
    operation: () => Promise<T>,
    context: string
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error: any) {
        lastError = error;

        if (axios.isAxiosError(error)) {
          // Don't retry on 4xx errors (except 429)
          if (!shouldRetry(error)) {
            const errorMessage = error.response?.data?.error || error.message;
            throw new Error(`${context} failed: ${errorMessage}`);
          }

          if (attempt < this.retryConfig.maxRetries) {
            const delay = calculateDelay(attempt, this.retryConfig);
            console.log(
              `[CashflowClient] ${context} attempt ${attempt + 1} failed, retrying in ${delay}ms...`
            );
            await sleep(delay);
          }
        } else {
          throw error;
        }
      }
    }

    throw lastError || new Error(`${context} failed after ${this.retryConfig.maxRetries} retries`);
  }

  /**
   * Import a completed sale to Cashflow
   * Creates an invoice (and optional payment) in Cashflow
   * 
   * @example
   * ```ts
   * const result = await cashflowClient.importSale({
   *   saleId: sale.id,
   *   saleNumber: sale.sale_number,
   *   saleDate: sale.sale_date.toISOString(),
   *   currency: "MMK",
   *   customer: {
   *     externalCustomerId: sale.customer?.id,
   *     name: sale.customer?.name ?? "Walk-in Customer",
   *     phone: sale.customer?.phone,
   *   },
   *   lines: sale.items.map(item => ({
   *     externalProductId: item.product_id,
   *     sku: item.sku,
   *     name: item.product_name,
   *     quantity: item.quantity,
   *     unitPrice: item.unit_price,
   *     discountAmount: item.discount_amount,
   *     taxRate: item.tax_rate,
   *   })),
   *   payments: [{
   *     cashflowAccountCode: "1000", // Cash
   *     amount: sale.total_amount,
   *     paidAt: sale.sale_date.toISOString(),
   *   }],
   * });
   * console.log(`Invoice created: ${result.invoiceNumber}`);
   * ```
   */
  async importSale(request: CashflowSaleRequest): Promise<CashflowSaleResponse> {
    const idempotencyKey = this.saleIdempotencyKey(request.saleId);

    return this.executeWithRetry(async () => {
      const response = await this.client.post<CashflowSaleResponse>(
        `/integrations/piti/companies/${this.companyId}/sales`,
        request,
        {
          headers: {
            "Idempotency-Key": idempotencyKey,
          },
        }
      );
      return response.data;
    }, `importSale(${request.saleId})`);
  }

  /**
   * Import a refund/return to Cashflow
   * Creates a credit note in Cashflow
   * 
   * @example
   * ```ts
   * const result = await cashflowClient.importRefund({
   *   refundId: refund.id,
   *   saleId: refund.original_sale_id,
   *   refundNumber: refund.refund_number,
   *   refundDate: refund.refund_date.toISOString(),
   *   currency: "MMK",
   *   lines: refund.items.map(item => ({
   *     externalProductId: item.product_id,
   *     name: item.product_name,
   *     quantity: item.quantity,
   *     unitPrice: item.unit_price,
   *   })),
   * });
   * console.log(`Credit note created: ${result.creditNoteNumber}`);
   * ```
   */
  async importRefund(request: CashflowRefundRequest): Promise<CashflowRefundResponse> {
    const idempotencyKey = this.refundIdempotencyKey(request.refundId);

    return this.executeWithRetry(async () => {
      const response = await this.client.post<CashflowRefundResponse>(
        `/integrations/piti/companies/${this.companyId}/refunds`,
        request,
        {
          headers: {
            "Idempotency-Key": idempotencyKey,
          },
        }
      );
      return response.data;
    }, `importRefund(${request.refundId})`);
  }

  /**
   * Health check - verify connectivity to Cashflow API
   */
  async healthCheck(): Promise<boolean> {
    try {
      // Simple GET to verify connectivity (adjust endpoint if needed)
      await this.client.get("/health");
      return true;
    } catch {
      return false;
    }
  }
}

// ============================================================================
// Singleton Factory (for use in Pitix service layer)
// ============================================================================

let _clientInstance: CashflowClient | null = null;

/**
 * Get or create CashflowClient singleton
 * 
 * @example
 * ```ts
 * import { getCashflowClient } from "app/service/cashflow_client";
 * 
 * const client = getCashflowClient("prod");
 * await client.importSale({ ... });
 * ```
 */
export const getCashflowClient = (env: AppENV = "dev"): CashflowClient => {
  if (!_clientInstance) {
    _clientInstance = CashflowClient.fromEnv(env);
  }
  return _clientInstance;
};

/**
 * Reset the singleton (useful for testing)
 */
export const resetCashflowClient = (): void => {
  _clientInstance = null;
};

export default CashflowClient;

