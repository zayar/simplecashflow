'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useAuth } from '@/contexts/auth-context';
import { fetchApi } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

type TabKey = 'overview' | 'locations' | 'transactions';

function renderStockMoveSource(m: any) {
  const type = String(m?.referenceType ?? '').trim();
  const ref = m?.referenceId != null ? String(m.referenceId).trim() : '';
  const isNumericId = ref && /^\d+$/.test(ref);

  switch (type) {
    case 'Invoice':
      return isNumericId ? (
        <Link className="text-sm underline" href={`/invoices/${ref}`}>
          Invoice #{ref}
        </Link>
      ) : (
        <span className="text-sm text-muted-foreground">Invoice</span>
      );
    case 'InvoiceVoid':
      return isNumericId ? (
        <Link className="text-sm underline" href={`/invoices/${ref}`}>
          Invoice void #{ref}
        </Link>
      ) : (
        <span className="text-sm text-muted-foreground">Invoice void</span>
      );
    case 'CreditNote':
      return isNumericId ? (
        <Link className="text-sm underline" href={`/credit-notes/${ref}`}>
          Credit note #{ref}
        </Link>
      ) : (
        <span className="text-sm text-muted-foreground">Credit note</span>
      );
    case 'CreditNoteVoid':
      return isNumericId ? (
        <Link className="text-sm underline" href={`/credit-notes/${ref}`}>
          Credit note void #{ref}
        </Link>
      ) : (
        <span className="text-sm text-muted-foreground">Credit note void</span>
      );
    case 'PurchaseBill':
      return isNumericId ? (
        <Link className="text-sm underline" href={`/purchase-bills/${ref}`}>
          Purchase bill #{ref}
        </Link>
      ) : (
        <span className="text-sm text-muted-foreground">Purchase bill</span>
      );
    case 'PurchaseBillVoid':
      return isNumericId ? (
        <Link className="text-sm underline" href={`/purchase-bills/${ref}`}>
          Purchase bill void #{ref}
        </Link>
      ) : (
        <span className="text-sm text-muted-foreground">Purchase bill void</span>
      );
    case 'InventoryAdjustment':
      return (
        <span className="text-sm text-muted-foreground">
          Adjustment{ref ? ` (${ref})` : ''}
        </span>
      );
    case 'OpeningBalance':
      return <span className="text-sm text-muted-foreground">Opening balance</span>;
    default:
      return type ? (
        <span className="text-sm text-muted-foreground">
          {type}
          {ref ? ` (${ref})` : ''}
        </span>
      ) : (
        <span className="text-sm text-muted-foreground">—</span>
      );
  }
}

export default function ItemDetailPage() {
  const { user } = useAuth();
  const params = useParams<{ id: string }>();
  const itemId = Number(params?.id);

  const [tab, setTab] = useState<TabKey>('overview');
  const [item, setItem] = useState<any | null>(null);
  const [balances, setBalances] = useState<any[]>([]);
  const [moves, setMoves] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    if (!user?.companyId || !itemId || Number.isNaN(itemId)) return;
    setLoading(true);
    try {
      const [it, b, m] = await Promise.all([
        fetchApi(`/companies/${user.companyId}/items/${itemId}`),
        fetchApi(`/companies/${user.companyId}/items/${itemId}/stock-balances`),
        fetchApi(`/companies/${user.companyId}/items/${itemId}/stock-moves?take=100`),
      ]);
      setItem(it);
      setBalances(b);
      setMoves(m);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load().catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.companyId, itemId]);

  const totals = useMemo(() => {
    const qty = balances.reduce((sum, r) => sum + Number(r.qtyOnHand ?? 0), 0);
    const value = balances.reduce((sum, r) => sum + Number(r.inventoryValue ?? 0), 0);
    const avgCost = qty > 0 ? value / qty : 0;
    return { qty, value, avgCost };
  }, [balances]);

  if (!user) return null;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1 min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-2xl font-semibold tracking-tight">
              {item?.name ?? (loading ? 'Loading...' : 'Item')}
            </h1>
            {item?.type ? <Badge variant="outline">{item.type}</Badge> : null}
            {item?.trackInventory ? <Badge>Inventory</Badge> : <Badge variant="secondary">Non-inventory</Badge>}
          </div>
          <p className="text-sm text-muted-foreground">
            SKU: <span className="font-medium">{item?.sku || '—'}</span>
          </p>
        </div>

        <div className="flex gap-2">
          <Link href="/items" className={buttonVariants({ variant: 'outline' })}>
            Back
          </Link>
          <Link
            href={`/inventory/opening-balance?itemId=${itemId}`}
            className={buttonVariants({ variant: 'outline' })}
          >
            Opening Stock
          </Link>
          <Link href="/inventory/adjustments" className={buttonVariants({ variant: 'default' })}>
            Adjust Stock
          </Link>
        </div>
      </div>

      <div className="flex gap-2">
        <Button variant={tab === 'overview' ? 'secondary' : 'ghost'} onClick={() => setTab('overview')}>
          Overview
        </Button>
        <Button variant={tab === 'locations' ? 'secondary' : 'ghost'} onClick={() => setTab('locations')}>
          Locations
        </Button>
        <Button variant={tab === 'transactions' ? 'secondary' : 'ghost'} onClick={() => setTab('transactions')}>
          Transactions
        </Button>
      </div>

      {tab === 'overview' && (
        <div className="grid gap-4 md:grid-cols-3">
          <Card className="shadow-sm md:col-span-2">
            <CardHeader>
              <CardTitle className="text-lg">Item details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">Selling Price</span>
                <span className="font-medium tabular-nums">{Number(item?.sellingPrice ?? 0).toLocaleString()}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">Cost Price</span>
                <span className="font-medium tabular-nums">{Number(item?.costPrice ?? 0).toLocaleString()}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">Income Account</span>
                <span className="font-medium">
                  {item?.incomeAccount ? `${item.incomeAccount.code} ${item.incomeAccount.name}` : '—'}
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">COGS Account</span>
                <span className="font-medium">
                  {item?.expenseAccount ? `${item.expenseAccount.code} ${item.expenseAccount.name}` : '—'}
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">Default Warehouse</span>
                <span className="font-medium">{item?.defaultWarehouse?.name ?? 'Company default'}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">Valuation</span>
                <span className="font-medium">{item?.valuationMethod ?? 'WAC'}</span>
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-sm">
            <CardHeader>
              <CardTitle className="text-lg">Accounting stock</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">Qty on hand</span>
                <span className="font-medium tabular-nums">{totals.qty.toLocaleString()}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">Avg cost (WAC)</span>
                <span className="font-medium tabular-nums">{totals.avgCost.toLocaleString()}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">Inventory value</span>
                <span className="font-medium tabular-nums">{totals.value.toLocaleString()}</span>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {tab === 'locations' && (
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">Stock by location</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Warehouse</TableHead>
                  <TableHead className="w-[140px] text-right">Qty</TableHead>
                  <TableHead className="w-[160px] text-right">Avg Cost</TableHead>
                  <TableHead className="w-[180px] text-right">Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {balances.map((b, idx) => (
                  <TableRow key={`${b.warehouse?.id ?? 'w'}-${idx}`}>
                    <TableCell className="font-medium">{b.warehouse?.name ?? '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{Number(b.qtyOnHand ?? 0).toLocaleString()}</TableCell>
                    <TableCell className="text-right tabular-nums">{Number(b.avgUnitCost ?? 0).toLocaleString()}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{Number(b.inventoryValue ?? 0).toLocaleString()}</TableCell>
                  </TableRow>
                ))}
                {balances.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="py-10 text-center text-muted-foreground">
                      No stock balances for this item yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {tab === 'transactions' && (
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">Stock transactions</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[140px]">Date</TableHead>
                  <TableHead className="w-[160px]">Type</TableHead>
                  <TableHead>Warehouse</TableHead>
                  <TableHead className="w-[120px] text-right">Qty</TableHead>
                  <TableHead className="w-[140px] text-right">Unit Cost</TableHead>
                  <TableHead className="w-[160px] text-right">Total</TableHead>
                  <TableHead className="w-[200px]">Source</TableHead>
                  <TableHead className="w-[120px]">GL</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {moves.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="text-muted-foreground">
                      {m.date ? String(m.date).slice(0, 10) : '—'}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {m.type} {m.direction === 'IN' ? '+' : '-'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{m.warehouse?.name ?? '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{Number(m.quantity ?? 0).toLocaleString()}</TableCell>
                    <TableCell className="text-right tabular-nums">{Number(m.unitCostApplied ?? 0).toLocaleString()}</TableCell>
                    <TableCell className="text-right tabular-nums">{Number(m.totalCostApplied ?? 0).toLocaleString()}</TableCell>
                    <TableCell>
                      <div className="space-y-0.5">
                        {renderStockMoveSource(m)}
                        <div className="text-[11px] text-muted-foreground">Move #{m.id}</div>
                      </div>
                    </TableCell>
                    <TableCell>
                      {m.journalEntryId ? (
                        <Link className="text-sm underline" href={`/journal/${m.journalEntryId}`}>
                          JE #{m.journalEntryId}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {moves.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
                      No stock moves for this item yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}


