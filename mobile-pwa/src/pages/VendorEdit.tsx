import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { getVendor, updateVendor } from '../lib/expenses';
import { AppBar, BackIcon, IconButton } from '../components/AppBar';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Button } from '../components/ui/button';

export default function VendorEdit() {
  const { user } = useAuth();
  const companyId = user?.companyId ?? 0;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const params = useParams();
  const vendorId = Number(params.id);

  const vendorQuery = useQuery({
    queryKey: ['vendor', companyId, vendorId],
    queryFn: async () => await getVendor(companyId, vendorId),
    enabled: companyId > 0 && Number.isFinite(vendorId) && vendorId > 0,
  });

  const [name, setName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [phone, setPhone] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (vendorQuery.data) {
      setName(vendorQuery.data.name ?? '');
      setEmail(vendorQuery.data.email ?? '');
      setPhone(vendorQuery.data.phone ?? '');
    }
  }, [vendorQuery.data]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!companyId) return setError('Missing company');
    if (!Number.isFinite(vendorId) || vendorId <= 0) return setError('Invalid vendor');
    if (!name.trim()) return setError('Name is required');
    setSaving(true);
    try {
      await updateVendor(companyId, vendorId, {
        name: name.trim(),
        email: email.trim() ? email.trim() : null,
        phone: phone.trim() ? phone.trim() : null,
      });
      
      // Invalidate queries
      await queryClient.invalidateQueries({ queryKey: ['vendors', companyId] });
      await queryClient.invalidateQueries({ queryKey: ['vendor', companyId, vendorId] });
      
      navigate('/vendors', { replace: true });
    } catch (err: any) {
      setError(err?.message ?? 'Failed to update vendor');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-dvh bg-background">
      <AppBar
        title="Edit Vendor"
        left={
          <IconButton ariaLabel="Back" onClick={() => navigate(-1)}>
            <BackIcon />
          </IconButton>
        }
        right={<div className="h-10 w-10" />}
      />

      <div className="mx-auto max-w-xl px-3 py-3">
        <Card className="rounded-2xl p-4 shadow-sm">
          {vendorQuery.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : vendorQuery.isError ? (
            <div className="text-sm text-destructive">Failed to load vendor.</div>
          ) : (
            <form className="space-y-4" onSubmit={onSubmit}>
              <div>
                <label className="mb-1 block text-sm font-medium text-foreground">Name</label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Vendor name" required />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-foreground">Email (optional)</label>
                <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@example.com" type="email" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-foreground">Phone (optional)</label>
                <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="09…" inputMode="tel" />
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

