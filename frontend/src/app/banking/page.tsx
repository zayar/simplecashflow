"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Landmark, Plus } from "lucide-react"

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

export default function BankingPage() {
  const { user } = useAuth();
  const [accounts, setAccounts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.companyId) return;
    setLoading(true);
    fetchApi(`/companies/${user.companyId}/banking-accounts`)
      .then(setAccounts)
      .finally(() => setLoading(false));
  }, [user?.companyId]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Banking</h1>
          <p className="text-sm text-muted-foreground">
            Deposit accounts (cash, bank, e‑wallet).
          </p>
        </div>
        <Link href="/banking/new">
          <Button className="gap-2">
            <Plus className="h-4 w-4" /> New Account
          </Button>
        </Link>
      </div>

      <Card className="shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-lg">Accounts</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {loading && (
            <div className="space-y-3 py-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          )}

          {!loading && accounts.length === 0 && (
            <div className="py-10 text-center text-sm text-muted-foreground">
              No banking accounts yet.
            </div>
          )}

          {!loading && accounts.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[120px]">Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead className="w-[140px]">Kind</TableHead>
                  <TableHead className="w-[200px]">Bank</TableHead>
                  <TableHead className="w-[120px]">Primary</TableHead>
                  <TableHead className="w-[110px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {accounts.map((a) => (
                  <TableRow key={`${a.id}-${a.account?.id ?? ""}`}>
                    <TableCell className="font-medium">{a.account?.code}</TableCell>
                    <TableCell>
                      <Link href={`/banking/${a.id}`} className="font-medium hover:underline">
                        {a.account?.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{a.kind}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{a.bankName ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {a.isPrimary ? "Primary" : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Link href={`/banking/${a.id}`}>
                        <Button variant="outline" size="sm">
                          View
                        </Button>
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}


