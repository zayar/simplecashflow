"use client"

import { useState } from "react"
import { useAuth } from "@/contexts/auth-context"
import { fetchApi } from "@/lib/api"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useRouter } from "next/navigation"
import { ArrowLeft, Info } from "lucide-react"
import Link from "next/link"

export default function NewTaxPage() {
  const { user } = useAuth()
  const companyId = user?.companyId ?? null
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [formData, setFormData] = useState({
    name: "",
    rate: "",
    isCompound: false,
  })

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!companyId) return

    setLoading(true)
    try {
      await fetchApi(`/companies/${companyId}/tax-rates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formData.name,
          // Backend stores rate as decimal (e.g. 0.10). UI input is percent (e.g. 10).
          rate: (parseFloat(formData.rate) || 0) / 100,
          isCompound: formData.isCompound,
        }),
      })
      router.push("/taxes")
    } catch (error: any) {
      alert(error.message || "Failed to create tax")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center gap-2">
        <Link href="/taxes">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">New Tax</h1>
      </div>

      <form onSubmit={handleSubmit}>
        <Card>
          <CardContent className="pt-6 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">
                Tax Name
                <span className="text-red-500">*</span>
              </Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g., Income tax, Sales Tax"
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="rate">
                Rate (%)
                <span className="text-red-500">*</span>
              </Label>
              <div className="relative">
                <Input
                  id="rate"
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  value={formData.rate}
                  onChange={(e) => setFormData({ ...formData, rate: e.target.value })}
                  placeholder="0.00"
                  required
                  className="pr-8"
                />
                <div className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                  %
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="isCompound"
                checked={formData.isCompound}
                onChange={(e) => setFormData({ ...formData, isCompound: e.target.checked })}
                className="rounded border-gray-300"
              />
              <Label htmlFor="isCompound" className="font-normal cursor-pointer">
                This tax is a compound tax.
              </Label>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                title="Compound tax is calculated on top of other taxes"
              >
                <Info className="h-4 w-4" />
              </button>
            </div>

            <div className="flex items-center gap-2 pt-4">
              <Button type="submit" disabled={loading}>
                {loading ? "Saving..." : "Save"}
              </Button>
              <Link href="/taxes">
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      </form>
    </div>
  )
}

