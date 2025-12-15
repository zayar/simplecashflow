'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { getBalanceSheet, BalanceSheetReport } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export default function BalanceSheetPage() {
  const { user } = useAuth();
  const [report, setReport] = useState<BalanceSheetReport | null>(null);
  const [loading, setLoading] = useState(false);
  
  const now = new Date().toISOString().split('T')[0];
  const [asOf, setAsOf] = useState(now);

  async function fetchReport() {
    if (!user?.companyId) return;
    setLoading(true);
    try {
      const data = await getBalanceSheet(user.companyId, asOf);
      setReport(data);
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (user?.companyId) {
      fetchReport();
    }
  }, [user?.companyId]);

  function SectionTable({ title, rows, total }: { title: string, rows: any[], total: string }) {
    return (
      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">{title}</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[120px]">Code</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead className="text-right w-[180px]">Balance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="py-10 text-center text-muted-foreground">
                      No {title.toLowerCase()} found.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((row) => (
                    <TableRow key={row.accountId}>
                      <TableCell className="font-medium">{row.code}</TableCell>
                      <TableCell>{row.name}</TableCell>
                      <TableCell className="text-right font-medium tabular-nums">
                        {Number(row.balance).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </TableCell>
                    </TableRow>
                  ))
                )}
                <TableRow className="bg-muted/40">
                  <TableCell colSpan={2} className="text-right font-medium">
                    Total {title}
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {Number(total).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Balance Sheet</h1>
        <p className="text-sm text-muted-foreground">
          Assets, liabilities, and equity at a point in time.
        </p>
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">Filter</CardTitle>
        </CardHeader>
        <CardContent className="flex items-end gap-4">
          <div className="grid w-full max-w-sm items-center gap-1.5">
            <Label htmlFor="asOf">As Of Date</Label>
            <Input 
              type="date" 
              id="asOf" 
              value={asOf} 
              onChange={(e) => setAsOf(e.target.value)} 
            />
          </div>
          <Button onClick={fetchReport} disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Run Report
          </Button>
        </CardContent>
      </Card>

      {report && (
        <div className="space-y-6">
           <div className="grid gap-4 md:grid-cols-3">
            <Card className="shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Total assets</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-semibold tabular-nums">
                  {Number(report.totals.assets).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </div>
              </CardContent>
            </Card>
            <Card className="shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Total liabilities</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-semibold tabular-nums">
                  {Number(report.totals.liabilities).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </div>
              </CardContent>
            </Card>
            <Card className="shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Total equity</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-semibold tabular-nums">
                  {Number(report.totals.equity).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </div>
              </CardContent>
            </Card>
          </div>

          <div>
            {report.totals.balanced ? (
              <Badge variant="secondary">Balanced</Badge>
            ) : (
              <Badge variant="destructive">Out of balance</Badge>
            )}
          </div>

          <SectionTable title="Assets" rows={report.assets} total={report.totals.assets} />
          <SectionTable title="Liabilities" rows={report.liabilities} total={report.totals.liabilities} />
          <SectionTable title="Equity" rows={report.equity} total={report.totals.equity} />
        </div>
      )}
    </div>
  );
}
