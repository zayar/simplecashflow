import React, { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { getCompanySettings, getWarehouses, updateCompanySettings, type Location } from '../lib/ar';
import { AppBar, BackIcon, IconButton, SearchIcon } from '../components/AppBar';
import { Card } from '../components/ui/card';

export default function Warehouses() {
  const { user } = useAuth();
  const companyId = user?.companyId ?? 0;
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const mode = params.get('mode'); // 'pick' or null
  const returnTo = params.get('returnTo') ?? '/invoices/new';
  const [q, setQ] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const qc = useQueryClient();

  const whQuery = useQuery({
    queryKey: ['warehouses', companyId],
    queryFn: async () => await getWarehouses(companyId),
    enabled: companyId > 0
  });

  const settingsQuery = useQuery({
    queryKey: ['company-settings', companyId],
    queryFn: async () => await getCompanySettings(companyId),
    enabled: companyId > 0
  });

  const rows = useMemo(() => {
    const list = (whQuery.data ?? []) as Location[];
    const s = q.trim().toLowerCase();
    const filtered = s ? list.filter((w) => String(w.name ?? '').toLowerCase().includes(s)) : list;
    return filtered.slice().sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  }, [whQuery.data, q]);

  async function pick(w: Location) {
    // NOTE: backend supports only company default warehouse, not per-invoice warehouse.
    await updateCompanySettings(companyId, { defaultLocationId: w.id });
    await qc.invalidateQueries({ queryKey: ['company-settings', companyId] });
    await qc.invalidateQueries({ queryKey: ['warehouses', companyId] });
    navigate(`${returnTo}?picked=1`, { replace: true });
  }

  const selectedId = (settingsQuery.data as any)?.defaultLocationId ?? (settingsQuery.data as any)?.defaultWarehouseId ?? null;

  return (
    <div className="min-h-dvh bg-background">
      <AppBar
        title="Location"
        left={
          <IconButton ariaLabel="Back" onClick={() => navigate(-1)}>
            <BackIcon />
          </IconButton>
        }
        right={
          <IconButton ariaLabel="Search" onClick={() => setSearchOpen((v) => !v)}>
            <SearchIcon />
          </IconButton>
        }
      />

      <div className="mx-auto max-w-xl px-3 pb-24 pt-3">
        {searchOpen ? (
          <Card className="mb-3 rounded-2xl p-3 shadow-sm">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search location…"
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            />
          </Card>
        ) : null}

        <Card className="overflow-hidden rounded-2xl shadow-sm">
          {whQuery.isLoading ? (
            <div className="p-4 text-sm text-muted-foreground">Loading…</div>
          ) : whQuery.isError ? (
            <div className="p-4 text-sm text-destructive">Failed to load branches.</div>
          ) : rows.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">No locations yet.</div>
          ) : (
            rows.map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={() => (mode === 'pick' ? pick(w) : undefined)}
                className="flex w-full items-center justify-between border-b border-border px-4 py-3 text-left active:bg-muted/50"
              >
                <div className="min-w-0">
                  <div className="truncate text-base text-foreground">{w.name}</div>
                  <div className="text-sm text-muted-foreground">
                    {selectedId === w.id ? 'Selected (default)' : w.isDefault ? 'Default' : ''}
                  </div>
                </div>
                <div className="text-muted-foreground">›</div>
              </button>
            ))
          )}
        </Card>

        <div className="mt-3 text-xs text-muted-foreground">
          Note: current API supports selecting a <b>company default location</b>, not per-invoice location.
        </div>
      </div>
    </div>
  );
}


