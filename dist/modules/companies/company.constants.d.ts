import { AccountReportGroup, AccountType, CashflowActivity } from '@prisma/client';
export type DefaultAccountSeed = {
    code: string;
    name: string;
    type: AccountType;
    reportGroup?: AccountReportGroup;
    cashflowActivity?: CashflowActivity;
};
export declare const DEFAULT_ACCOUNTS: DefaultAccountSeed[];
//# sourceMappingURL=company.constants.d.ts.map