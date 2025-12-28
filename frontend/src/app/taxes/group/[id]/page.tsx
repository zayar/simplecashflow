"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import { ArrowLeft } from "lucide-react"

import { useAuth } from "@/contexts/auth-context"
import { fetchApi } from "@/lib/api"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export default function EditTaxGroupPage() {
  const { user } = useAuth()
  const companyId = user?.companyId ?? null
  const params = useParams<{ id: string }>()
  const taxGroupId = params?.id
  const router = useRouter()

  const [loading, setLoading] = useState(false)
  const [loadingDoc, setLoadingDoc] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [formData, setFormData] = useState({
    name: "",
    isActive: true,
  })

  useEffect(() => {
    if (!companyId || !taxGroupId) return
    setLoadingDoc(true)
    setError(null)
    fetchApi(`/companies/${companyId}/tax-groups/${taxGroupId}`)
      .then((g) => {
        setFormData({
          name: String(g?.name ?? ""),
          isActive: Boolean(g?.isActive ?? true),
        })
      })
      .catch((e) => setError(e?.message ?? String(e)))
      .finally(() => setLoadingDoc(false))
  }, [companyId, taxGroupId])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!companyId || !taxGroupId) return
    setLoading(true)
    setError(null)
    try {
      await fetchApi(`/companies/${companyId}/tax-groups/${taxGroupId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formData.name,
          isActive: formData.isActive,
        }),
      })
      router.push("/taxes")
    } catch (e: any) {
      setError(e?.message ?? "Failed to update tax group")
    } finally {
      setLoading(false)
    }
  }

  async function setActive(nextActive: boolean) {
    if (!companyId || !taxGroupId) return
    setLoading(true)
    setError(null)
    try {
      await fetchApi(`/companies/${companyId}/tax-groups/${taxGroupId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: nextActive }),
      })
      setFormData((p) => ({ ...p, isActive: nextActive }))
    } catch (e: any) {
      setError(e?.message ?? "Failed to update tax group")
    } finally {
      setLoading(false)
    }
  }

  async function deleteGroup() {
    if (!companyId || !taxGroupId) return
    if (!confirm("Delete this tax group?")) return
    setLoading(true)
    setError(null)
    try {
      await fetchApi(`/companies/${companyId}/tax-groups/${taxGroupId}`, { method: "DELETE" })
      router.push("/taxes")
    } catch (e: any) {
      setError(e?.message ?? "Failed to delete tax group")
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
        <h1 className="text-2xl font-semibold tracking-tight">Edit Tax Group</h1>
      </div>

      {error ? <div className="text-sm text-red-600">{error}</div> : null}

      {loadingDoc ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">Loading…</CardContent>
        </Card>
      ) : (
        <form onSubmit={handleSubmit}>
          <Card>
            <CardContent className="pt-6 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">
                  Group Name <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="name"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  required
                />
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="isActive"
                  checked={formData.isActive}
                  onChange={(e) => setFormData({ ...formData, isActive: e.target.checked })}
                  className="rounded border-gray-300"
                />
                <Label htmlFor="isActive" className="font-normal cursor-pointer">
                  Active
                </Label>
              </div>

              <div className="flex items-center gap-2 pt-4">
                <Button type="submit" disabled={loading}>
                  {loading ? "Saving..." : "Save"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={loading}
                  onClick={() => setActive(!formData.isActive)}
                >
                  {formData.isActive ? "Deactivate" : "Activate"}
                </Button>
                <Button type="button" variant="destructive" disabled={loading} onClick={deleteGroup}>
                  Delete
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
      )}
    </div>
  )
}


