'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/auth-context';
import { createAccount } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2 } from 'lucide-react';

const ACCOUNT_TYPES = [
  'ASSET',
  'LIABILITY',
  'EQUITY',
  'INCOME',
  'EXPENSE',
];

const REPORT_GROUPS = [
  { value: 'CASH_AND_CASH_EQUIVALENTS', label: 'Cash & Cash Equivalents' },
  { value: 'ACCOUNTS_RECEIVABLE', label: 'Accounts Receivable' },
  { value: 'INVENTORY', label: 'Inventory' },
  { value: 'OTHER_CURRENT_ASSET', label: 'Other Current Asset' },
  { value: 'FIXED_ASSET', label: 'Fixed Asset' },
  { value: 'ACCOUNTS_PAYABLE', label: 'Accounts Payable' },
  { value: 'OTHER_CURRENT_LIABILITY', label: 'Other Current Liability' },
  { value: 'LONG_TERM_LIABILITY', label: 'Long Term Liability' },
  { value: 'EQUITY', label: 'Equity' },
  { value: 'SALES_REVENUE', label: 'Sales Revenue' },
  { value: 'OTHER_INCOME', label: 'Other Income' },
  { value: 'COGS', label: 'Cost of Goods Sold' },
  { value: 'OPERATING_EXPENSE', label: 'Operating Expense' },
  { value: 'OTHER_EXPENSE', label: 'Other Expense' },
  { value: 'TAX_EXPENSE', label: 'Tax Expense' },
];

const CASHFLOW_ACTIVITIES = [
  'OPERATING',
  'INVESTING',
  'FINANCING',
];

export default function NewAccountPage() {
  const router = useRouter();
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [formData, setFormData] = useState({
    code: '',
    name: '',
    type: 'ASSET',
    reportGroup: '',
    cashflowActivity: '',
  });

  const [reportGroupTouched, setReportGroupTouched] = useState(false);
  const [cashflowTouched, setCashflowTouched] = useState(false);

  const recommendedCashflow = useMemo(() => {
    const type = formData.type;
    const rg = formData.reportGroup;
    if (rg === 'FIXED_ASSET') return 'INVESTING';
    if (rg === 'LONG_TERM_LIABILITY') return 'FINANCING';
    if (type === 'EQUITY') return 'FINANCING';
    return 'OPERATING';
  }, [formData.type, formData.reportGroup]);

  const recommendedReportGroup = useMemo(() => {
    const type = formData.type;
    const code = String(formData.code ?? '').trim();
    const name = String(formData.name ?? '').trim().toLowerCase();
    if (type === 'ASSET') {
      if (['1000', '1010'].includes(code) || /\b(cash|bank|wallet|e-?wallet)\b/.test(name)) return 'CASH_AND_CASH_EQUIVALENTS';
      if (/receivable/.test(name) || code.startsWith('12')) return 'ACCOUNTS_RECEIVABLE';
      if (/inventory/.test(name) || code.startsWith('13')) return 'INVENTORY';
      if (/equipment|furniture|fixture|fixed asset|property|plant/.test(name) || code.startsWith('15')) return 'FIXED_ASSET';
    }
    if (type === 'LIABILITY') {
      if (/payable/.test(name) || code.startsWith('20')) return 'ACCOUNTS_PAYABLE';
      if (/loan|debt|note payable|mortgage/.test(name) || code.startsWith('25')) return 'LONG_TERM_LIABILITY';
    }
    if (type === 'EQUITY') return 'EQUITY';
    return '';
  }, [formData.type, formData.code, formData.name]);

  // Auto-fill recommendations unless the user explicitly chose something.
  useEffect(() => {
    setFormData((prev) => {
      const next = { ...prev };
      if (!cashflowTouched && !next.cashflowActivity) next.cashflowActivity = recommendedCashflow;
      if (!reportGroupTouched && !next.reportGroup && recommendedReportGroup) next.reportGroup = recommendedReportGroup;
      return next;
    });
  }, [recommendedCashflow, recommendedReportGroup, cashflowTouched, reportGroupTouched]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!user?.companyId) return;

    setLoading(true);
    setError('');

    try {
      await createAccount(user.companyId, {
        ...formData,
        reportGroup: formData.reportGroup || undefined,
        cashflowActivity: formData.cashflowActivity || undefined,
      });
      router.push('/accounts');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">New Account</h1>
      </div>

      <div className="max-w-2xl rounded-lg border bg-white p-6 shadow-sm">
        <form onSubmit={handleSubmit} className="space-y-6">
          {error && (
            <div className="rounded-md bg-red-50 p-4 text-sm text-red-500">
              {error}
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="code">Account Code</Label>
              <Input
                id="code"
                required
                placeholder="e.g. 1000"
                value={formData.code}
                onChange={(e) => setFormData({ ...formData, code: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="name">Account Name</Label>
              <Input
                id="name"
                required
                placeholder="e.g. Petty Cash"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="type">Account Type</Label>
            <select
              id="type"
              className="flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm ring-offset-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-950 focus-visible:ring-offset-2"
              value={formData.type}
              onChange={(e) => {
                const nextType = e.target.value;
                setFormData((prev) => ({ ...prev, type: nextType }));
                // When type changes, re-apply cashflow default unless user explicitly chose one.
                if (!cashflowTouched) {
                  setFormData((prev) => ({ ...prev, cashflowActivity: '' }));
                }
                if (!reportGroupTouched) {
                  setFormData((prev) => ({ ...prev, reportGroup: '' }));
                }
              }}
            >
              {ACCOUNT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="reportGroup">Report Group (Optional)</Label>
              <select
                id="reportGroup"
                className="flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm ring-offset-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-950 focus-visible:ring-offset-2"
                value={formData.reportGroup}
                onChange={(e) => {
                  setReportGroupTouched(true);
                  setFormData({ ...formData, reportGroup: e.target.value });
                }}
              >
                <option value="">None</option>
                {REPORT_GROUPS.map((group) => (
                  <option key={group.value} value={group.value}>
                    {group.label}
                  </option>
                ))}
              </select>
              {!reportGroupTouched && recommendedReportGroup ? (
                <div className="text-xs text-muted-foreground">
                  Recommended: <span className="font-medium">{recommendedReportGroup}</span>
                </div>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label htmlFor="cashflowActivity">Cashflow Activity (Optional)</Label>
              <select
                id="cashflowActivity"
                className="flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm ring-offset-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-950 focus-visible:ring-offset-2"
                value={formData.cashflowActivity}
                onChange={(e) => {
                  setCashflowTouched(true);
                  setFormData({ ...formData, cashflowActivity: e.target.value });
                }}
              >
                <option value="">None</option>
                {CASHFLOW_ACTIVITIES.map((activity) => (
                  <option key={activity} value={activity}>
                    {activity}
                  </option>
                ))}
              </select>
              {!cashflowTouched ? (
                <div className="text-xs text-muted-foreground">
                  Recommended: <span className="font-medium">{recommendedCashflow}</span>
                </div>
              ) : null}
            </div>
          </div>

          <div className="flex gap-4 pt-4">
            <Button type="submit" disabled={loading}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create Account
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => router.push('/accounts')}
            >
              Cancel
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
