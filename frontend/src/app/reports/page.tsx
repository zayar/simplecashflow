'use client';

import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { BarChart, Scale, PieChart, Waves, CalendarCheck2, Package, TrendingUp, ShoppingCart, Users } from 'lucide-react';

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
  {
    title: 'Inventory Valuation (As of)',
    description: 'Inventory quantity and value as of a specific date, based on recorded stock moves.',
    href: '/reports/inventory-valuation',
    icon: Package,
  },
  {
    title: 'Inventory Movement',
    description: 'In/Out quantities and values by item and location for a date range.',
    href: '/reports/inventory-movement',
    icon: TrendingUp,
  },
  {
    title: 'COGS by Item',
    description: 'Cost of goods sold by item from posted sales (WAC-based).',
    href: '/reports/cogs-by-item',
    icon: ShoppingCart,
  },
  {
    title: 'AP Aging by Vendor',
    description: 'Outstanding payables grouped by vendor and aging buckets.',
    href: '/reports/ap-aging',
    icon: Users,
  },
];

export default function ReportsPage() {
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
        <p className="text-sm text-muted-foreground">
          Financial statements and closing tools.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {reports.map((report) => (
          <Link key={report.href} href={report.href}>
            <Card className="h-full shadow-sm transition-colors hover:bg-muted/30">
              <CardHeader>
                <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-lg border bg-background text-muted-foreground">
                  <report.icon className="h-5 w-5" />
                </div>
                <CardTitle className="text-lg">{report.title}</CardTitle>
                <CardDescription>{report.description}</CardDescription>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
