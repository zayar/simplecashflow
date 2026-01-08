import React from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { createItem } from '../lib/ar';
import { AppBar, BackIcon, IconButton } from '../components/AppBar';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Button } from '../components/ui/button';
import { toNumber } from '../lib/format';
import { getInvoiceDraft, setInvoiceDraft } from '../lib/invoiceDraft';

export default function ItemNew() {
  const { user } = useAuth();
  const companyId = user?.companyId ?? 0;
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const mode = params.get('mode'); // 'pick' or null
  const returnTo = params.get('returnTo') ?? '/invoices/new';

  const [name, setName] = React.useState('');
  const [price, setPrice] = React.useState('');
  const [sku, setSku] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!companyId) return setError('Missing company');
    if (!name.trim()) return setError('Item name is required');
    const sellingPrice = toNumber(price);
    if (!Number.isFinite(sellingPrice) || sellingPrice < 0) return setError('Price must be 0 or more');
    setSaving(true);
    try {
      const created = await createItem(companyId, {
        name: name.trim(),
        sellingPrice,
        sku: sku.trim() ? sku.trim() : null,
      });
      if (mode === 'pick') {
        const draft = getInvoiceDraft();
        const idx = Number(draft.activeLineIndex ?? 0);
        const safeIdx = Number.isFinite(idx) && idx >= 0 ? idx : 0;
        const nextLines = (draft.lines ?? []).map((l, i) => {
          if (i !== safeIdx) return l;
          return {
            ...l,
            itemId: created.id,
            itemName: created.name,
            unitPrice: Math.max(0, toNumber((created as any).sellingPrice)),
          };
        });
        setInvoiceDraft({ ...draft, lines: nextLines, activeLineIndex: null, returnTo: null });
        const sep = returnTo.includes('?') ? '&' : '?';
        navigate(`${returnTo}${sep}picked=1`, { replace: true });
      } else {
        navigate('/items', { replace: true });
      }
    } catch (err: any) {
      setError(err?.message ?? 'Failed to create item');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-dvh bg-background">
      <AppBar
        title="New Item"
        left={
          <IconButton ariaLabel="Back" onClick={() => navigate(-1)}>
            <BackIcon />
          </IconButton>
        }
        right={<div className="h-10 w-10" />}
      />

      <div className="mx-auto max-w-xl px-3 py-3">
        <Card className="rounded-2xl p-4 shadow-sm">
          <form className="space-y-4" onSubmit={onSubmit}>
            <div>
              <label className="mb-1 block text-sm font-medium text-foreground">Item name</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Item name" required />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-foreground">Price</label>
              <Input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0" inputMode="decimal" />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-foreground">SKU (optional)</label>
              <Input value={sku} onChange={(e) => setSku(e.target.value)} placeholder="SKU" />
            </div>

            {error ? (
              <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            ) : null}

            <Button className="w-full" disabled={saving} type="submit">
              {saving ? 'Creating…' : 'Create Item'}
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}


