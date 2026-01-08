'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search, ChevronDown, PlusCircle, Check } from 'lucide-react';
import { createPortal } from 'react-dom';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export type AccountLike = {
  id: number;
  code?: string | null;
  name: string;
  type?: string | null;
  reportGroup?: string | null;
  isActive?: boolean;
};

function labelForGroup(groupKey: string) {
  switch (groupKey) {
    case 'SALES_REVENUE':
      return 'Sales';
    case 'OTHER_INCOME':
      return 'Other Income';
    case 'COGS':
      return 'COGS';
    case 'OPERATING_EXPENSE':
      return 'Expense';
    case 'OTHER_EXPENSE':
      return 'Other Expense';
    case 'TAX_EXPENSE':
      return 'Tax Expense';
    case 'INCOME':
      return 'Income';
    case 'EXPENSE':
      return 'Expense';
    case 'ASSET':
      return 'Asset';
    case 'LIABILITY':
      return 'Liability';
    case 'EQUITY':
      return 'Equity';
    default:
      return groupKey.replaceAll('_', ' ');
  }
}

function groupKeyForAccount(a: AccountLike) {
  // Prefer reportGroup when present (gives Sales vs Other Income, etc)
  if (a.reportGroup) return a.reportGroup;
  if (a.type) return a.type;
  return 'Other';
}

export function AccountPicker(props: {
  value: string | number | null | undefined;
  onChange: (nextId: number | null) => void;
  accounts: AccountLike[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  emptyLabel?: string;
  createHref?: string;
  isOptionDisabled?: (a: AccountLike) => boolean;
  getOptionDisabledReason?: (a: AccountLike) => string | undefined;
}) {
  const {
    value,
    onChange,
    accounts,
    placeholder = 'Select an account',
    disabled,
    className,
    emptyLabel = 'No accounts',
    createHref = '/accounts/new',
    isOptionDisabled,
    getOptionDisabledReason,
  } = props;

  const router = useRouter();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties | null>(null);

  const selectedId = value === '' || value === undefined ? null : value === null ? null : Number(value);
  const selected = useMemo(() => accounts.find((a) => a.id === selectedId) ?? null, [accounts, selectedId]);

  const filtered = useMemo(() => {
    const base = (accounts ?? []).filter((a) => a.isActive !== false);
    const term = q.trim().toLowerCase();
    if (!term) return base;
    return base.filter((a) => {
      const hay = `${a.code ?? ''} ${a.name ?? ''}`.toLowerCase();
      return hay.includes(term);
    });
  }, [accounts, q]);

  const grouped = useMemo(() => {
    const map = new Map<string, AccountLike[]>();
    for (const a of filtered) {
      const key = groupKeyForAccount(a);
      const arr = map.get(key) ?? [];
      arr.push(a);
      map.set(key, arr);
    }
    // stable-ish ordering: Sales first, then other income, then expenses, then the rest
    const priority: string[] = ['SALES_REVENUE', 'OTHER_INCOME', 'INCOME', 'COGS', 'OPERATING_EXPENSE', 'EXPENSE', 'OTHER_EXPENSE', 'TAX_EXPENSE'];
    const keys = Array.from(map.keys()).sort((a, b) => {
      const ai = priority.indexOf(a);
      const bi = priority.indexOf(b);
      if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
      return a.localeCompare(b);
    });
    return keys.map((k) => ({
      key: k,
      label: labelForGroup(k),
      items: (map.get(k) ?? []).sort((x, y) => (x.name ?? '').localeCompare(y.name ?? '')),
    }));
  }, [filtered]);

  useEffect(() => {
    function onDocDown(e: MouseEvent) {
      if (!open) return;
      const root = rootRef.current;
      const panel = panelRef.current;
      if (!root && !panel) return;
      if (!(e.target instanceof Node)) return;
      // Because the dropdown is rendered in a portal, we must treat clicks inside the panel as "inside".
      const clickedInsideRoot = root ? root.contains(e.target) : false;
      const clickedInsidePanel = panel ? panel.contains(e.target) : false;
      if (!clickedInsideRoot && !clickedInsidePanel) setOpen(false);
    }
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [open]);

  useEffect(() => {
    if (!open) setQ('');
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setPanelStyle(null);
      return;
    }
    function compute() {
      const btn = buttonRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      const dropdownH = 360; // max height; enough for search + list + footer
      const gap = 8;
      const spaceBelow = window.innerHeight - r.bottom;
      const openUp = spaceBelow < dropdownH + gap && r.top > dropdownH + gap;
      const top = openUp ? Math.max(8, r.top - gap - dropdownH) : r.bottom + gap;
      setPanelStyle({
        position: 'fixed',
        left: Math.max(8, r.left),
        top,
        width: Math.max(280, r.width),
        zIndex: 60,
      });
    }

    compute();
    window.addEventListener('scroll', compute, true);
    window.addEventListener('resize', compute);
    return () => {
      window.removeEventListener('scroll', compute, true);
      window.removeEventListener('resize', compute);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <Button
        ref={buttonRef}
        type="button"
        variant="outline"
        disabled={disabled}
        className={cn('w-full justify-between font-normal', className)}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={cn('truncate', selected ? 'text-foreground' : 'text-muted-foreground')}>
          {selected ? selected.name : placeholder}
        </span>
        <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-70" />
      </Button>

      {open && panelStyle
        ? createPortal(
        <div ref={panelRef} style={panelStyle} className="rounded-lg border bg-background shadow-lg">
          <div className="p-2 border-b">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input className="pl-8" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          </div>

          <div className="max-h-80 overflow-auto p-2">
            {grouped.length === 0 ? (
              <div className="px-2 py-3 text-sm text-muted-foreground">{emptyLabel}</div>
            ) : (
              grouped.map((g) => (
                <div key={g.key} className="mb-2">
                  <div className="px-2 py-1 text-xs font-semibold text-muted-foreground">{g.label}</div>
                  <div className="space-y-1">
                    {g.items.map((a) => {
                      const isSelected = selectedId === a.id;
                      const optDisabled = Boolean(isOptionDisabled?.(a));
                      const disabledReason = getOptionDisabledReason?.(a);
                      return (
                        <button
                          key={a.id}
                          type="button"
                          disabled={optDisabled}
                          title={optDisabled ? disabledReason ?? 'Not selectable' : undefined}
                          className={cn(
                            'w-full rounded-md px-3 py-2 text-left text-sm hover:bg-muted flex items-center justify-between',
                            isSelected ? 'bg-muted' : '',
                            optDisabled ? 'opacity-45 hover:bg-transparent cursor-not-allowed' : ''
                          )}
                          onClick={() => {
                            if (optDisabled) return;
                            onChange(a.id);
                            setOpen(false);
                          }}
                        >
                          <span className="truncate">{a.name}</span>
                          {isSelected ? <Check className="h-4 w-4 text-primary" /> : null}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))
            )}

            <div className="mt-2 border-t pt-2">
              <button
                type="button"
                className="w-full rounded-md px-3 py-2 text-left text-sm text-primary hover:bg-muted flex items-center gap-2"
                onClick={() => {
                  setOpen(false);
                  router.push(createHref);
                }}
              >
                <PlusCircle className="h-4 w-4" />
                New Account
              </button>
            </div>
          </div>
        </div>,
        document.body
        )
        : null}
    </div>
  );
}


