import React from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

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

function SheetRow({
  label,
  onClick
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 px-5 py-4 text-left active:bg-muted/50"
    >
      <div className="text-base text-foreground">{label}</div>
      <div className="ml-auto text-muted-foreground">›</div>
    </button>
  );
}

export function BottomNav() {
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = React.useState(false);
  const isMoreActive =
    open ||
    location.pathname.startsWith('/customers') ||
    location.pathname.startsWith('/items') ||
    location.pathname.startsWith('/warehouses') ||
    location.pathname.startsWith('/more');

  return (
    <>
      <div className="fixed bottom-0 left-0 right-0 z-10 border-t border-border bg-background/95 backdrop-blur">
        <div className="mx-auto grid max-w-xl grid-cols-4 safe-bottom">
          <Tab to="/invoices" label="Invoices" icon={<DocIcon />} />
          <Tab to="/expenses" label="Expenses" icon={<ReceiptIcon />} />
          <Tab to="/reports" label="Reports" icon={<ChartIcon />} />
          <button
            type="button"
            onClick={() => setOpen(true)}
            className={`flex w-full flex-col items-center justify-center gap-1 py-2 text-xs ${
              isMoreActive ? 'text-primary' : 'text-muted-foreground'
            }`}
          >
            <div className="h-6 w-6">
              <MoreIcon />
            </div>
            <div>More</div>
          </button>
        </div>
      </div>

      {open ? (
        <div className="fixed inset-0 z-50">
          <button
            type="button"
            className="absolute inset-0 bg-black/40"
            onClick={() => setOpen(false)}
            aria-label="Close"
          />
          <div className="absolute bottom-0 left-0 right-0 mx-auto max-w-xl rounded-t-3xl bg-background shadow-xl">
            <div className="px-5 pb-2 pt-3">
              <div className="mx-auto h-1.5 w-12 rounded-full bg-muted" />
            </div>

            <SheetRow
              label="Clients"
              onClick={() => {
                setOpen(false);
                navigate('/customers');
              }}
            />
            <div className="h-px bg-border" />
            <SheetRow
              label="Items"
              onClick={() => {
                setOpen(false);
                navigate('/items');
              }}
            />

            <div className="safe-bottom" />
          </div>
        </div>
      ) : null}
    </>
  );
}


