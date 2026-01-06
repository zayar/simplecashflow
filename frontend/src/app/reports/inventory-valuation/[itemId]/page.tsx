'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/contexts/auth-context';
import { fetchApi } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SelectNative } from '@/components/ui/select-native';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ArrowLeft } from 'lucide-react';
import { todayInTimeZone } from '@/lib/utils';

function d2(n: any) {
  const x = Number(n ?? 0);
  if (Number.isNaN(x)) return '0.00';
  return x.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function ymd(date: Date) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export default function InventoryValuationDetailPage() {
  const { user, companySettings } = useAuth();
  const params = useParams<{ itemId: string }>();
  const router = useRouter();
  const search = useSearchParams();

  const itemId = Number(params?.itemId);
  const tz = companySettings?.timeZone ?? 'Asia/Yangon';

  const [locations, setLocations] = useState<any[]>([]);
  const [locationId, setLocationId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<any | null>(null);

  useEffect(() => {
    if (!user?.companyId) return;
    fetchApi(`/companies/${user.companyId}/locations`).then(setLocations).catch(console.error);
  }, [user?.companyId]);

  useEffect(() => {
    // Initialize filters from query string or sane defaults.
    const qsFrom = (search?.get('from') ?? '').trim();
    const qsTo = (search?.get('to') ?? '').trim();
    const qsLoc = (search?.get('locationId') ?? '').trim();
    if (qsLoc) setLocationId(qsLoc);

    const today = todayInTimeZone(tz); // YYYY-MM-DD
    const year = today.slice(0, 4);
    if (!from) setFrom(qsFrom || `${year}-01-01`);
    if (!to) setTo(qsTo || today);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tz]);

  async function load() {
    if (!user?.companyId || !itemId) return;
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      qs.set('from', from);
      qs.set('to', to);
      if (locationId) qs.set('locationId', locationId);
      const res = await fetchApi(
        `/companies/${user.companyId}/reports/inventory-valuation/items/${itemId}?${qs.toString()}`
      );
      setData(res);

      // Keep URL in sync (shareable deep link)
      router.replace(`/reports/inventory-valuation/${itemId}?${qs.toString()}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Auto load once on first render when we have defaults.
    if (!user?.companyId || !itemId) return;
    if (!from || !to) return;
    load().catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.companyId, itemId, from, to]);

  const title = useMemo(() => {
    const name = data?.item?.name ?? `Item #${itemId}`;
    const sku = data?.item?.sku ? ` (${data.item.sku})` : '';
    return `${name}${sku}`;
  }, [data, itemId]);

  const rows = useMemo(() => (data?.rows ?? []) as any[], [data]);

  const closing = useMemo(() => {
    const last = rows.length ? rows[rows.length - 1] : null;
    return last?.kind === 'CLOSING' ? last : null;
  }, [rows]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/reports/inventory-valuation">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="space-y-1 min-w-0">
          <div className="text-xs text-muted-foreground truncate">{companySettings?.companyName ?? ''}</div>
          <h1 className="text-2xl font-semibold tracking-tight truncate">Inventory Valuation for {title}</h1>
          <div className="text-sm text-muted-foreground">
            From {from || '—'} to {to || '—'}
          </div>
        </div>
      </div>

      <Card className="shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-lg">Filters</CardTitle>
          {closing ? (
            <div className="text-sm text-muted-foreground">
              Closing value:{' '}
              <span className="font-medium tabular-nums">{d2(closing.inventoryAssetValue ?? 0)}</span>
            </div>
          ) : null}
        </CardHeader>
        <CardContent className="pt-0">
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1">
              <div className="text-sm text-muted-foreground">From</div>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="grid gap-1">
              <div className="text-sm text-muted-foreground">To</div>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <div className="grid gap-1 min-w-[240px]">
              <div className="text-sm text-muted-foreground">Location</div>
              <SelectNative value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                <option value="">All locations</option>
                {locations.map((l) => (
                  <option key={l.id} value={String(l.id)}>
                    {l.name}
                    {l.isDefault ? ' (Default)' : ''}
                  </option>
                ))}
              </SelectNative>
            </div>
            <Button onClick={load} disabled={loading || !from || !to}>
              {loading ? 'Loading…' : 'Run'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">Inventory valuation</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="mb-3 text-xs text-muted-foreground">
            Cost method: <b>Moving Average (WAC)</b>. “Unit cost” on Sale (Issue) rows is the cost used for that transaction.
            “Avg cost after” is calculated as <b>Inventory asset value ÷ Stock on hand</b> after each row.
          </div>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[140px]">Date</TableHead>
                  <TableHead>Transaction details</TableHead>
                  <TableHead className="text-right w-[120px]">Quantity</TableHead>
                  <TableHead className="text-right w-[140px]">Unit cost</TableHead>
                  <TableHead className="text-right w-[160px]">Total cost</TableHead>
                  <TableHead className="text-right w-[150px]">Stock on hand</TableHead>
                  <TableHead className="text-right w-[190px]">Inventory asset value</TableHead>
                  <TableHead className="text-right w-[160px]">Avg cost after</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r, idx) => {
                  const date = r?.date ? String(r.date).slice(0, 10) : '';
                  const isMarker = r.kind === 'OPENING' || r.kind === 'CLOSING';
                  const soh = Number(r.stockOnHand ?? 0);
                  const invVal = Number(r.inventoryAssetValue ?? 0);
                  const avgAfter = soh && Number.isFinite(soh) && Number.isFinite(invVal) ? invVal / soh : 0;
                  return (
                    <TableRow key={`${r.kind}-${r.stockMoveId ?? idx}`} className={isMarker ? 'bg-muted/30' : ''}>
                      <TableCell className="text-muted-foreground">{date}</TableCell>
                      <TableCell className={isMarker ? 'font-medium text-emerald-700' : ''}>
                        <div className="flex items-center justify-between gap-2">
                          <span>{r.transactionDetails}</span>
                          {!isMarker && r.journalEntryId ? (
                            <Link className="text-xs underline text-muted-foreground" href={`/journal/${r.journalEntryId}`}>
                              JE #{r.journalEntryId}
                            </Link>
                          ) : null}
                        </div>
                        {!isMarker && r.locationName ? (
                          <div className="text-xs text-muted-foreground">{r.locationName}</div>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.quantity != null ? d2(r.quantity).replace('.00', '') : ''}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{r.unitCost != null ? d2(r.unitCost) : ''}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.totalCost != null ? d2(r.totalCost) : ''}</TableCell>
                      <TableCell className="text-right tabular-nums">{d2(r.stockOnHand ?? 0).replace('.00', '')}</TableCell>
                      <TableCell className="text-right tabular-nums">{d2(r.inventoryAssetValue ?? 0)}</TableCell>
                      <TableCell className="text-right tabular-nums">{d2(avgAfter)}</TableCell>
                    </TableRow>
                  );
                })}
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
                      No rows for this range.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}


