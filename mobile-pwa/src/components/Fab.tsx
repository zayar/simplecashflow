import React from 'react';

export function Fab({
  onClick,
  ariaLabel,
  icon,
  label,
  disabled
}: {
  onClick: () => void;
  ariaLabel: string;
  icon: React.ReactNode;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      disabled={disabled}
      className={`fixed bottom-[76px] right-5 z-20 rounded-full bg-primary text-primary-foreground shadow-lg active:scale-[0.99] disabled:opacity-60 ${
        label ? 'flex h-14 items-center gap-2 px-5' : 'grid h-14 w-14 place-items-center'
      }`}
    >
      <span className="grid h-8 w-8 place-items-center">{icon}</span>
      {label ? <span className="text-sm font-semibold">{label}</span> : null}
    </button>
  );
}

export function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M22 2L11 13" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M22 2l-7 20-4-9-9-4 20-7z" />
    </svg>
  );
}

export function SaveIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M17 21v-8H7v8" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 3v5h8" />
    </svg>
  );
}


