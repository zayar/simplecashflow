"use client"

import { useEffect, useState } from "react"
import { useAuth } from "@/contexts/auth-context"
import { fetchApi } from "@/lib/api"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import Link from "next/link"
import { Plus, Search } from "lucide-react"
import { Input } from "@/components/ui/input"

type TaxRate = {
  id: number
  name: string
  ratePercent: number
  isCompound: boolean
  isActive: boolean
}

type TaxGroup = {
  id: number
  name: string
  totalRatePercent: number
  isActive: boolean
  members: Array<{
    taxRateId: number
    taxRateName: string
    rate: number
  }>
}

export default function TaxesPage() {
  const { user } = useAuth()
  const companyId = user?.companyId ?? null
  const [taxRates, setTaxRates] = useState<TaxRate[]>([])
  const [taxGroups, setTaxGroups] = useState<TaxGroup[]>([])
  const [filter, setFilter] = useState<'all' | 'rate' | 'group'>('all')
  const [searchTerm, setSearchTerm] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!companyId) {
      setLoading(false)
      return
    }
    
    Promise.all([
      fetchApi(`/companies/${companyId}/tax-rates`),
      fetchApi(`/companies/${companyId}/tax-groups`),
    ])
      .then(([rates, groups]) => {
        setTaxRates(rates)
        setTaxGroups(groups)
      })
      .catch((err) => {
        console.error(err)
        // Don't leave the page stuck on "Loading..." forever.
        setTaxRates([])
        setTaxGroups([])
      })
      .finally(() => setLoading(false))
  }, [companyId])

  if (!user) return null

  // Filter and search
  const filteredRates = taxRates.filter((rate) => {
    if (filter === 'group') return false
    return rate.name.toLowerCase().includes(searchTerm.toLowerCase())
  })

  const filteredGroups = taxGroups.filter((group) => {
    if (filter === 'rate') return false
    return group.name.toLowerCase().includes(searchTerm.toLowerCase())
  })

  const allItems = [
    ...filteredRates.map((r) => ({ ...r, type: 'rate' as const })),
    ...filteredGroups.map((g) => ({ ...g, type: 'group' as const })),
  ]

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Taxes</h1>
          <p className="text-sm text-muted-foreground">
            Manage tax rates and tax groups
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/taxes/new">
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              New Tax
            </Button>
          </Link>
          <Button variant="ghost" size="icon">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
            </svg>
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Button
                variant={filter === 'all' ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setFilter('all')}
              >
                Active taxes
                <svg className="ml-1 h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-[250px] pl-8"
                />
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="text-center py-8 text-muted-foreground">Loading...</div>
          ) : allItems.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No taxes found. Create your first tax rate or group.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b">
                  <tr className="text-left text-sm text-muted-foreground">
                    <th className="pb-3 font-medium">
                      <input type="checkbox" className="rounded border-gray-300" />
                    </th>
                    <th className="pb-3 font-medium">TAX NAME</th>
                    <th className="pb-3 font-medium text-right">RATE (%)</th>
                    <th className="pb-3 font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {allItems.map((item) => (
                    <tr
                      key={`${item.type}-${item.id}`}
                      className="border-b last:border-0 hover:bg-muted/50"
                    >
                      <td className="py-3">
                        <input type="checkbox" className="rounded border-gray-300" />
                      </td>
                      <td className="py-3">
                        <Link
                          href={`/taxes/${item.type}/${item.id}`}
                          className="text-primary hover:underline"
                        >
                          {item.name}
                        </Link>
                        {item.type === 'group' && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            (Tax Group)
                          </span>
                        )}
                      </td>
                      <td className="py-3 text-right tabular-nums">
                        {item.type === 'rate'
                          ? (item as TaxRate).ratePercent.toFixed(2)
                          : (item as TaxGroup).totalRatePercent.toFixed(2)}
                      </td>
                      <td className="py-3 text-right">
                        <Button variant="ghost" size="sm">
                          Edit
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

