"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { useAuth } from "@/contexts/auth-context";
import { fetchApi, refundCreditNote } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import { todayInTimeZone } from "@/lib/utils";

export default function RefundCreditNotePage() {
  const { user, companySettings } = useAuth();
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const creditNoteId = Number(params?.id);
  const tz = companySettings?.timeZone ?? "Asia/Yangon";

  const [cn, setCn] = useState<any | null>(null);
  const [bankingAccounts, setBankingAccounts] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState({
    refundDate: "",
    bankAccountId: "",
    amount: "",
    reference: "",
    description: "",
  });

  useEffect(() => {
    if (!form.refundDate) setForm((p) => ({ ...p, refundDate: todayInTimeZone(tz) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tz]);

  useEffect(() => {
    if (!user?.companyId || !creditNoteId) return;
    fetchApi(`/companies/${user.companyId}/credit-notes/${creditNoteId}`)
      .then((x) => {
        setCn(x);
        const remaining = Number(x?.creditsRemaining ?? 0);
        if (!form.amount && remaining > 0) setForm((p) => ({ ...p, amount: String(remaining.toFixed(2)) }));
      })
      .catch((e) => setError(e?.message ?? "Failed to load credit note"));

    fetchApi(`/companies/${user.companyId}/banking-accounts`)
      .then(setBankingAccounts)
      .catch(() => setBankingAccounts([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.companyId, creditNoteId]);

  const creditsRemaining = useMemo(() => Number(cn?.creditsRemaining ?? 0), [cn]);
  const canRefund = useMemo(() => {
    const amt = Number(form.amount);
    return (
      !!user?.companyId &&
      !!creditNoteId &&
      cn?.status === "POSTED" &&
      creditsRemaining > 0 &&
      !!form.bankAccountId &&
      !!form.refundDate &&
      Number.isFinite(amt) &&
      amt > 0 &&
      amt <= creditsRemaining
    );
  }, [user?.companyId, creditNoteId, cn?.status, creditsRemaining, form.bankAccountId, form.refundDate, form.amount]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!user?.companyId) return;
    setError(null);
    setLoading(true);
    try {
      await refundCreditNote(user.companyId, creditNoteId, {
        amount: Number(form.amount),
        refundDate: form.refundDate,
        bankAccountId: Number(form.bankAccountId),
        reference: form.reference?.trim() || null,
        description: form.description?.trim() || null,
      });
      router.push(`/credit-notes/${creditNoteId}`);
    } catch (err: any) {
      setError(err?.message ?? "Refund failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href={`/credit-notes/${creditNoteId}`}>
          <Button variant="ghost" size="icon" aria-label="Back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Refund</h1>
          <p className="text-sm text-muted-foreground">
            Refund open credit note balance back to customer.
          </p>
        </div>
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">Refund ({cn?.creditNoteNumber ?? `#${creditNoteId}`})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 md:grid-cols-2">
            <div className="rounded-lg border bg-muted/10 p-3 text-sm">
              <div className="text-muted-foreground">Customer</div>
              <div className="font-medium">{cn?.customer?.name ?? "—"}</div>
            </div>
            <div className="rounded-lg border bg-muted/10 p-3 text-sm">
              <div className="text-muted-foreground">Balance</div>
              <div className="font-semibold tabular-nums">{creditsRemaining.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
            </div>
          </div>

          <form onSubmit={onSubmit} className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="grid gap-2">
                <Label>Amount*</Label>
                <Input
                  type="number"
                  step="0.01"
                  min="0.01"
                  max={creditsRemaining}
                  value={form.amount}
                  onChange={(e) => setForm((p) => ({ ...p, amount: e.target.value }))}
                />
              </div>
              <div className="grid gap-2">
                <Label>Refunded On*</Label>
                <Input
                  type="date"
                  value={form.refundDate}
                  onChange={(e) => setForm((p) => ({ ...p, refundDate: e.target.value }))}
                />
              </div>
            </div>

            <div className="grid gap-2">
              <Label>From Account*</Label>
              <SelectNative
                value={form.bankAccountId}
                onChange={(e) => setForm((p) => ({ ...p, bankAccountId: e.target.value }))}
              >
                <option value="">Select account</option>
                {bankingAccounts.map((row: any) => (
                  <option key={`${row.id}-${row.account?.id ?? ""}`} value={String(row.account?.id ?? "")}>
                    {row.account?.code} - {row.account?.name}
                  </option>
                ))}
              </SelectNative>
              <p className="text-xs text-muted-foreground">Only accounts under <b>Banking</b> can be used here.</p>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="grid gap-2">
                <Label>Reference#</Label>
                <Input
                  value={form.reference}
                  onChange={(e) => setForm((p) => ({ ...p, reference: e.target.value }))}
                  placeholder="Optional"
                />
              </div>
              <div className="grid gap-2">
                <Label>Description</Label>
                <Input
                  value={form.description}
                  onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
                  placeholder="Optional"
                />
              </div>
            </div>

            {error ? <div className="text-sm text-destructive">{error}</div> : null}

            <div className="flex justify-end gap-2 pt-2">
              <Link href={`/credit-notes/${creditNoteId}`}>
                <Button type="button" variant="outline" disabled={loading}>Cancel</Button>
              </Link>
              <Button type="submit" disabled={!canRefund || loading} loading={loading} loadingText="Saving...">
                Save
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

