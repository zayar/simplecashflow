import React from 'react';
import { Link, useLocation } from 'react-router-dom';

function Tab({
  to,
  label,
  icon,
  disabled
}: {
  to: string;
  label: string;
  icon: React.ReactNode;
  disabled?: boolean;
}) {
  const location = useLocation();
  const active = location.pathname === to || (to === '/invoices' && location.pathname === '/');
  const cls = active ? 'text-primary' : 'text-muted-foreground';

  if (disabled) {
    return (
      <button
        type="button"
        className="flex w-full flex-col items-center justify-center gap-1 py-2 text-xs text-slate-400"
        disabled
      >
        <div className="h-6 w-6 opacity-60">{icon}</div>
        <div>{label}</div>
      </button>
    );
  }

  return (
    <Link to={to} className={`flex w-full flex-col items-center justify-center gap-1 py-2 text-xs ${cls}`}>
      <div className="h-6 w-6">{icon}</div>
      <div>{label}</div>
    </Link>
  );
}

function DocIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 3h7l3 3v15a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M14 3v4h4" />
    </svg>
  );
}

function ListIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 6h13M8 12h13M8 18h13" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 6h.01M3 12h.01M3 18h.01" />
    </svg>
  );
}

function ReceiptIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 3h10a2 2 0 0 1 2 2v16l-2-1-2 1-2-1-2 1-2-1-2 1V5a2 2 0 0 1 2-2z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 7h6M9 11h6M9 15h4" />
    </svg>
  );
}

function ChartIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 19V5" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 19h16" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 17V9" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 17V7" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M16 17v-5" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h.01M12 12h.01M19 12h.01" />
    </svg>
  );
}

export function BottomNav() {
  return (
    <div className="fixed bottom-0 left-0 right-0 z-10 border-t border-border bg-background/95 backdrop-blur">
      <div className="mx-auto grid max-w-xl grid-cols-5 safe-bottom">
        <Tab to="/invoices" label="Invoices" icon={<DocIcon />} />
        <Tab to="/estimates" label="Estimates" icon={<ListIcon />} disabled />
        <Tab to="/expenses" label="Expenses" icon={<ReceiptIcon />} disabled />
        <Tab to="/reports" label="Reports" icon={<ChartIcon />} disabled />
        <Tab to="/more" label="More" icon={<MoreIcon />} />
      </div>
    </div>
  );
}


