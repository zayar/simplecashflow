import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { getCustomer, updateCustomer } from '../lib/ar';
import { AppBar, BackIcon, IconButton } from '../components/AppBar';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Button } from '../components/ui/button';

export default function CustomerEdit() {
  const { user } = useAuth();
  const companyId = user?.companyId ?? 0;
  const navigate = useNavigate();
  const params = useParams();
  const customerId = Number(params.id);

  const customerQuery = useQuery({
    queryKey: ['customer', companyId, customerId],
    queryFn: async () => await getCustomer(companyId, customerId),
    enabled: companyId > 0 && Number.isFinite(customerId) && customerId > 0,
  });

  const [name, setName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [phone, setPhone] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (customerQuery.data) {
      setName(customerQuery.data.name ?? '');
      setEmail(customerQuery.data.email ?? '');
      setPhone(customerQuery.data.phone ?? '');
    }
  }, [customerQuery.data]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!companyId) return setError('Missing company');
    if (!Number.isFinite(customerId) || customerId <= 0) return setError('Invalid client');
    if (!name.trim()) return setError('Name is required');
    setSaving(true);
    try {
      await updateCustomer(companyId, customerId, {
        name: name.trim(),
        email: email.trim() ? email.trim() : null,
        phone: phone.trim() ? phone.trim() : null,
      });
      navigate('/customers', { replace: true });
    } catch (err: any) {
      setError(err?.message ?? 'Failed to update client');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-dvh bg-background">
      <AppBar
        title="Edit Client"
        left={
          <IconButton ariaLabel="Back" onClick={() => navigate(-1)}>
            <BackIcon />
          </IconButton>
        }
        right={<div className="h-10 w-10" />}
      />

      <div className="mx-auto max-w-xl px-3 py-3">
        <Card className="rounded-2xl p-4 shadow-sm">
          {customerQuery.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : customerQuery.isError ? (
            <div className="text-sm text-destructive">Failed to load client.</div>
          ) : (
            <form className="space-y-4" onSubmit={onSubmit}>
              <div>
                <label className="mb-1 block text-sm font-medium text-foreground">Name</label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Client name" required />
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


