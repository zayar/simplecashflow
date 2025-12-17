"use client"

import { useEffect, useState } from "react"
import { useAuth } from "@/contexts/auth-context"
import { fetchApi } from "@/lib/api"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { formatDateInputInTimeZone, todayInTimeZone } from "@/lib/utils"

export default function Dashboard() {
  const { user, isLoading, companySettings } = useAuth()
  const [pnl, setPnl] = useState<any>(null);

  useEffect(() => {
    if (user?.companyId) {
      const tz = companySettings?.timeZone ?? "Asia/Yangon"
      const today = todayInTimeZone(tz)
      const parts = today.split("-").map((x) => Number(x))
      const y = parts[0]
      const m = parts[1] // 1-12
      if (!y || !m) return

      const from = formatDateInputInTimeZone(new Date(Date.UTC(y, m - 1, 1)), tz)
      const to = formatDateInputInTimeZone(new Date(Date.UTC(y, m, 0)), tz)

      fetchApi(`/reports/pnl?companyId=${user.companyId}&from=${from}&to=${to}`)
        .then(setPnl)
        .catch(console.error);
    }
  }, [user?.companyId, companySettings?.timeZone]);

  if (isLoading || !user) return null;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="text-sm text-muted-foreground">
          This month’s performance snapshot.
        </p>
      </div>
      
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total income</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold tabular-nums">
              {Number(pnl?.totalIncome ?? 0).toLocaleString()}
            </div>
            <div className="mt-2 flex items-center justify-between">
              <p className="text-xs text-muted-foreground">This month</p>
              <Badge variant="outline">Income</Badge>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total expense</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold tabular-nums">
              {Number(pnl?.totalExpense ?? 0).toLocaleString()}
            </div>
            <div className="mt-2 flex items-center justify-between">
              <p className="text-xs text-muted-foreground">This month</p>
              <Badge variant="outline">Expense</Badge>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Net profit</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold tabular-nums">
              {Number(pnl?.netProfit ?? 0).toLocaleString()}
            </div>
            <div className="mt-2 flex items-center justify-between">
              <p className="text-xs text-muted-foreground">This month</p>
              <Badge variant="secondary">Net</Badge>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
