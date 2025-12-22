import { AccountReportGroup, AccountType, CashflowActivity } from '@prisma/client';
export const DEFAULT_ACCOUNTS = [
    {
        code: "1000",
        name: "Cash",
        type: AccountType.ASSET,
        reportGroup: AccountReportGroup.CASH_AND_CASH_EQUIVALENTS,
        cashflowActivity: CashflowActivity.OPERATING,
    },
    {
        code: "1010",
        name: "Bank",
        type: AccountType.ASSET,
        reportGroup: AccountReportGroup.CASH_AND_CASH_EQUIVALENTS,
        cashflowActivity: CashflowActivity.OPERATING,
    },
    {
        code: "1200",
        name: "Accounts Receivable",
        type: AccountType.ASSET,
        reportGroup: AccountReportGroup.ACCOUNTS_RECEIVABLE,
        cashflowActivity: CashflowActivity.OPERATING,
    },
    {
        code: "1300",
        name: "Inventory",
        type: AccountType.ASSET,
        reportGroup: AccountReportGroup.INVENTORY,
        cashflowActivity: CashflowActivity.OPERATING,
    },
    {
        code: "1500",
        name: "Equipment",
        type: AccountType.ASSET,
        reportGroup: AccountReportGroup.FIXED_ASSET,
        cashflowActivity: CashflowActivity.INVESTING,
    },
    {
        code: "1510",
        name: "Furniture & Fixtures",
        type: AccountType.ASSET,
        reportGroup: AccountReportGroup.FIXED_ASSET,
        cashflowActivity: CashflowActivity.INVESTING,
    },
    {
        code: "2000",
        name: "Accounts Payable",
        type: AccountType.LIABILITY,
        reportGroup: AccountReportGroup.ACCOUNTS_PAYABLE,
        cashflowActivity: CashflowActivity.OPERATING,
    },
    {
        // Used for opening balances (including opening stock). Common pattern in accounting systems.
        code: "3050",
        name: "Opening Balance Equity",
        type: AccountType.EQUITY,
        reportGroup: AccountReportGroup.EQUITY,
        cashflowActivity: CashflowActivity.FINANCING,
    },
    {
        code: "3000",
        name: "Owner Equity",
        type: AccountType.EQUITY,
        reportGroup: AccountReportGroup.EQUITY,
        cashflowActivity: CashflowActivity.FINANCING,
    },
    {
        code: "4000",
        name: "Sales Income",
        type: AccountType.INCOME,
        reportGroup: AccountReportGroup.SALES_REVENUE,
        cashflowActivity: CashflowActivity.OPERATING,
    },
    {
        code: "5001",
        name: "Cost of Goods Sold",
        type: AccountType.EXPENSE,
        reportGroup: AccountReportGroup.COGS,
        cashflowActivity: CashflowActivity.OPERATING,
    },
    {
        code: "5000",
        name: "General Expense",
        type: AccountType.EXPENSE,
        reportGroup: AccountReportGroup.OPERATING_EXPENSE,
        cashflowActivity: CashflowActivity.OPERATING,
    },
];
//# sourceMappingURL=company.constants.js.map