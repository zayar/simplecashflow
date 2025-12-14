'use client';

import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { BarChart, Scale, PieChart, Waves, CalendarCheck2 } from 'lucide-react';

const reports = [
  {
    title: 'Trial Balance',
    description: 'View the closing balances of all accounts to ensure debits equal credits.',
    href: '/reports/trial-balance',
    icon: Scale,
  },
  {
    title: 'Profit & Loss',
    description: 'Analyze revenue, expenses, and net profit over a specific period.',
    href: '/reports/profit-loss',
    icon: BarChart,
  },
  {
    title: 'Balance Sheet',
    description: 'Snapshot of assets, liabilities, and equity at a specific point in time.',
    href: '/reports/balance-sheet',
    icon: PieChart,
  },
  {
    title: 'Cashflow Statement',
    description: 'Indirect cashflow: net profit + working capital changes, plus investing and financing.',
    href: '/reports/cashflow',
    icon: Waves,
  },
  {
    title: 'Period Close',
    description: 'Close income & expense into Retained Earnings (month-end / year-end).',
    href: '/reports/period-close',
    icon: CalendarCheck2,
  },
];

export default function ReportsPage() {
  return (
    <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
      {reports.map((report) => (
        <Link key={report.href} href={report.href}>
          <Card className="h-full transition-all hover:bg-slate-50">
            <CardHeader>
              <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-lg bg-blue-100 text-blue-600">
                <report.icon className="h-6 w-6" />
              </div>
              <CardTitle>{report.title}</CardTitle>
              <CardDescription>{report.description}</CardDescription>
            </CardHeader>
          </Card>
        </Link>
      ))}
    </div>
  );
}
