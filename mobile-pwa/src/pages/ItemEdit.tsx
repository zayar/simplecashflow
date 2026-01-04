import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { getItem, updateItem } from '../lib/ar';
import { AppBar, BackIcon, IconButton } from '../components/AppBar';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Button } from '../components/ui/button';
import { toNumber } from '../lib/format';

export default function ItemEdit() {
  const { user } = useAuth();
  const companyId = user?.companyId ?? 0;
  const navigate = useNavigate();
  const params = useParams();
  const itemId = Number(params.id);

  const itemQuery = useQuery({
    queryKey: ['item', companyId, itemId],
    queryFn: async () => await getItem(companyId, itemId),
    enabled: companyId > 0 && Number.isFinite(itemId) && itemId > 0,
  });

  const [name, setName] = React.useState('');
  const [price, setPrice] = React.useState('');
  const [sku, setSku] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (itemQuery.data) {
      setName(itemQuery.data.name ?? '');
      setSku(itemQuery.data.sku ?? '');
      const p = itemQuery.data.sellingPrice ?? 0;
      setPrice(String(typeof p === 'string' ? toNumber(p) : p));
    }
  }, [itemQuery.data]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!companyId) return setError('Missing company');
    if (!Number.isFinite(itemId) || itemId <= 0) return setError('Invalid item');
    if (!name.trim()) return setError('Item name is required');
    const sellingPrice = toNumber(price);
    if (!Number.isFinite(sellingPrice) || sellingPrice < 0) return setError('Price must be 0 or more');
    setSaving(true);
    try {
      await updateItem(companyId, itemId, {
        name: name.trim(),
        sellingPrice,
        sku: sku.trim() ? sku.trim() : null,
      });
      navigate('/items', { replace: true });
    } catch (err: any) {
      setError(err?.message ?? 'Failed to update item');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-dvh bg-background">
      <AppBar
        title="Edit Item"
        left={
          <IconButton ariaLabel="Back" onClick={() => navigate(-1)}>
            <BackIcon />
          </IconButton>
        }
        right={<div className="h-10 w-10" />}
      />

      <div className="mx-auto max-w-xl px-3 py-3">
        <Card className="rounded-2xl p-4 shadow-sm">
          {itemQuery.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : itemQuery.isError ? (
            <div className="text-sm text-destructive">Failed to load item.</div>
          ) : (
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
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </form>
          )}
        </Card>
      </div>
    </div>
  );
}


