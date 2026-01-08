"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { useAuth } from "@/contexts/auth-context";
import { createVendorAdvance, fetchApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import { todayInTimeZone } from "@/lib/utils";

export default function NewVendorAdvancePage() {
  const { user, companySettings } = useAuth();
  const router = useRouter();
  const search = useSearchParams();
  const tz = companySettings?.timeZone ?? "Asia/Yangon";

  const vendorId = Number(search?.get("vendorId") ?? 0) || 0;
  const returnTo = search?.get("returnTo") ?? "";

  const [loading, setLoading] = useState(false);
  const [vendor, setVendor] = useState<any | null>(null);
  const [bankingAccounts, setBankingAccounts] = useState<any[]>([]);
  const [locations, setLocations] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState({
    advanceDate: "",
    amount: "",
    bankAccountId: "",
    locationId: "",
    reference: "",
    description: "",
  });

  useEffect(() => {
    if (!form.advanceDate) setForm((p) => ({ ...p, advanceDate: todayInTimeZone(tz) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tz]);

  useEffect(() => {
    if (!user?.companyId) return;
    // Load banking accounts (pay from) + locations
    fetchApi(`/companies/${user.companyId}/banking-accounts`).then(setBankingAccounts).catch(() => setBankingAccounts([]));
    fetchApi(`/companies/${user.companyId}/locations`).then(setLocations).catch(() => setLocations([]));
  }, [user?.companyId]);

  useEffect(() => {
    if (!user?.companyId || !vendorId) return;
    fetchApi(`/companies/${user.companyId}/vendors/${vendorId}`)
      .then(setVendor)
      .catch(() => setVendor(null));
  }, [user?.companyId, vendorId]);

  useEffect(() => {
    // Default location to company default if we have it
    if (form.locationId) return;
    const def = locations.find((l: any) => l?.isDefault) ?? null;
    if (def?.id) setForm((p) => ({ ...p, locationId: String(def.id) }));
  }, [locations, form.locationId]);

  const canSubmit = useMemo(() => {
    return !!vendorId && !!form.amount && !!form.bankAccountId && !!form.locationId && !!form.advanceDate;
  }, [vendorId, form.amount, form.bankAccountId, form.locationId, form.advanceDate]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!user?.companyId) return;
    if (!vendorId) return setError("vendorId is required");
    setError(null);
    setLoading(true);
    try {
      await createVendorAdvance(user.companyId, {
        vendorId,
        locationId: Number(form.locationId),
        bankAccountId: Number(form.bankAccountId),
        advanceDate: form.advanceDate,
        amount: Number(form.amount),
        reference: form.reference?.trim() || null,
        description: form.description?.trim() || null,
      });
      if (returnTo) {
        router.push(returnTo);
      } else {
        router.push(`/purchase-bills`);
      }
    } catch (err: any) {
      setError(err?.message ?? "Failed to create vendor advance");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href={returnTo || "/purchase-bills"}>
          <Button variant="ghost" size="icon" aria-label="Back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Record Vendor Advance</h1>
          <p className="text-sm text-muted-foreground">
            Supplier prepayment (asset). Later you can apply it to a purchase bill.
          </p>
        </div>
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">Advance</CardTitle>
        </CardHeader>
        <CardContent>
          {!vendorId ? (
            <div className="text-sm text-destructive">Missing vendorId in URL.</div>
          ) : (
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="text-sm">
                <span className="text-muted-foreground">Vendor:</span>{" "}
                <b>{vendor?.name ?? `#${vendorId}`}</b>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="grid gap-2">
                  <Label>Advance Date</Label>
                  <Input
                    type="date"
                    value={form.advanceDate}
                    onChange={(e) => setForm((p) => ({ ...p, advanceDate: e.target.value }))}
                  />
                </div>
                <div className="grid gap-2">
                  <Label>Amount</Label>
                  <Input
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={form.amount}
                    onChange={(e) => setForm((p) => ({ ...p, amount: e.target.value }))}
                    placeholder="0"
                  />
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="grid gap-2">
                  <Label>Pay From</Label>
                  <SelectNative
                    value={form.bankAccountId}
                    onChange={(e) => setForm((p) => ({ ...p, bankAccountId: e.target.value }))}
                  >
                    <option value="">Select a banking account…</option>
                    {bankingAccounts.map((b: any) => (
                      <option key={`${b.id}-${b.account?.id ?? ""}`} value={String(b.account?.id ?? "")}>
                        {b.account?.code ?? ""} - {b.account?.name ?? "Account"}
                      </option>
                    ))}
                  </SelectNative>
                </div>
                <div className="grid gap-2">
                  <Label>Location</Label>
                  <SelectNative
                    value={form.locationId}
                    onChange={(e) => setForm((p) => ({ ...p, locationId: e.target.value }))}
                  >
                    <option value="">Select a location…</option>
                    {locations.map((l: any) => (
                      <option key={l.id} value={String(l.id)}>
                        {l.name}
                      </option>
                    ))}
                  </SelectNative>
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="grid gap-2">
                  <Label>Reference</Label>
                  <Input
                    value={form.reference}
                    onChange={(e) => setForm((p) => ({ ...p, reference: e.target.value }))}
                    placeholder="e.g. Txn ID"
                  />
                </div>
                <div className="grid gap-2">
                  <Label>Description</Label>
                  <Input
                    value={form.description}
                    onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
                    placeholder="Optional note"
                  />
                </div>
              </div>

              {error ? <div className="text-sm text-destructive">{error}</div> : null}

              <div className="flex justify-end gap-2">
                <Link href={returnTo || "/purchase-bills"}>
                  <Button type="button" variant="outline" disabled={loading}>
                    Cancel
                  </Button>
                </Link>
                <Button type="submit" disabled={!canSubmit || loading} loading={loading} loadingText="Saving...">
                  Save Advance
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

