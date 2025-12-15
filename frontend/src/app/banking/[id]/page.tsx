"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { ArrowLeft } from "lucide-react"

import { useAuth } from "@/contexts/auth-context"
import { fetchApi } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

function formatMoney(n: any) {
  const num = Number(n ?? 0);
  if (Number.isNaN(num)) return String(n ?? '');
  return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export default function BankingAccountDetailPage() {
  const { user } = useAuth();
  const params = useParams();
  const id = params.id;

  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.companyId || !id) return;
    setLoading(true);
    fetchApi(`/companies/${user.companyId}/banking-accounts/${id}`)
      .then(setData)
      .finally(() => setLoading(false));
  }, [user?.companyId, id]);

  const balanceLabel = useMemo(() => {
    if (!data) return '';
    const b = Number(data.balance ?? 0);
    const suffix = b >= 0 ? 'Dr' : 'Cr';
    return `${formatMoney(Math.abs(b))} (${suffix})`;
  }, [data]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Link href="/banking">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Banking</h1>
            <p className="text-sm text-muted-foreground">Account details</p>
          </div>
        </div>
        <Card className="shadow-sm">
          <CardContent className="pt-6 space-y-3">
            <Skeleton className="h-10 w-2/3" />
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-64 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Link href="/banking">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Banking</h1>
            <p className="text-sm text-muted-foreground">Account details</p>
          </div>
        </div>
        <Card className="shadow-sm">
          <CardContent className="pt-6">
            <p className="text-center text-muted-foreground">Account not found.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/banking">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="min-w-0 space-y-1">
          <h1 className="truncate text-2xl font-semibold tracking-tight">
            {data.account?.name}
          </h1>
          <p className="text-sm text-muted-foreground">
            {data.kind} • COA {data.account?.code} • {data.bankName ?? "—"}
          </p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Closing balance
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-semibold tracking-tight tabular-nums">
              {balanceLabel}
            </div>
            <div className="mt-2">
              {data.isPrimary ? (
                <Badge variant="secondary">Primary</Badge>
              ) : (
                <Badge variant="outline">Not primary</Badge>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Account
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">Code</span>
              <span className="font-medium tabular-nums">{data.account?.code ?? "—"}</span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">Provider</span>
              <span className="font-medium">{data.bankName ?? "—"}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">Recent transactions</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[140px]">Date</TableHead>
                <TableHead>Details</TableHead>
                <TableHead className="w-[140px]">Type</TableHead>
                <TableHead className="text-right w-[140px]">Debit</TableHead>
                <TableHead className="text-right w-[140px]">Credit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data.transactions ?? []).map((t: any, idx: number) => (
                <TableRow key={idx}>
                  <TableCell className="text-muted-foreground">
                    {t.date ? new Date(t.date).toLocaleDateString() : "—"}
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">{t.details}</div>
                    <div className="text-xs text-muted-foreground">JE #{t.journalEntryId}</div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{t.type}</Badge>
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {formatMoney(t.debit)}
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {formatMoney(t.credit)}
                  </TableCell>
                </TableRow>
              ))}
              {(data.transactions ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                    No transactions yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}


