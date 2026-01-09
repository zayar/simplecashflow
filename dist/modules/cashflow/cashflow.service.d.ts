import type { PrismaTx } from '../ledger/posting.service.js';
export type CashflowScenario = 'base' | 'conservative' | 'optimistic';
export type CashflowForecastOptions = {
    asOfDate?: Date;
    weeks?: number;
    scenario?: CashflowScenario;
};
export type CashflowDriver = {
    kind: 'invoice';
    id: number;
    label: string;
    expectedDate: string;
    amount: string;
} | {
    kind: 'purchase_bill' | 'expense';
    id: number;
    label: string;
    expectedDate: string;
    amount: string;
} | {
    kind: 'recurring';
    id: number;
    label: string;
    expectedDate: string;
    amount: string;
};
export type CashflowForecastWeek = {
    weekStart: string;
    cashIn: string;
    cashOut: string;
    net: string;
    endingCash: string;
};
export type CashflowForecastResult = {
    asOfDate: string;
    weeks: number;
    scenario: CashflowScenario;
    currency: string | null;
    warnings: string[];
    startingCash: string;
    minCashBuffer: string;
    lowestCash: {
        weekStart: string;
        endingCash: string;
    } | null;
    series: CashflowForecastWeek[];
    topInflows: CashflowDriver[];
    topOutflows: CashflowDriver[];
    alerts: {
        severity: 'high' | 'medium' | 'low';
        code: string;
        message: string;
        weekStart?: string;
    }[];
};
export declare function computeCashflowForecast(tx: PrismaTx, companyId: number, options?: CashflowForecastOptions): Promise<CashflowForecastResult>;
//# sourceMappingURL=cashflow.service.d.ts.map