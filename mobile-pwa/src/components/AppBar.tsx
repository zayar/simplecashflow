import React from 'react';

export function AppBar({
  title,
  left,
  right
}: {
  title: string;
  left?: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="sticky top-0 z-20 bg-primary text-primary-foreground">
      <div className="relative mx-auto flex h-14 max-w-xl items-center px-3">
        <div className="flex w-10 items-center justify-start">{left}</div>
        {/* Center title must not block taps on left/right controls */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="text-base font-semibold tracking-tight">{title}</div>
        </div>
        <div className="ml-auto flex w-10 items-center justify-end">{right}</div>
      </div>
    </div>
  );
}

export function IconButton({
  onClick,
  children,
  ariaLabel
}: {
  onClick?: () => void;
  children: React.ReactNode;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className="rounded-full p-2 text-primary-foreground/90 active:bg-primary-foreground/10"
    >
      {children}
    </button>
  );
}

export function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 18l-6-6 6-6" />
    </svg>
  );
}

export function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z"
      />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M19.4 15a7.9 7.9 0 0 0 .1-1l2-1.5-2-3.5-2.4.7a7.3 7.3 0 0 0-1.7-1L15 6h-6l-.4 2.7a7.3 7.3 0 0 0-1.7 1L4.5 9l-2 3.5L4.5 14a7.9 7.9 0 0 0 .1 1L2.5 16.5l2 3.5 2.4-.7a7.3 7.3 0 0 0 1.7 1L9 22h6l.4-2.7a7.3 7.3 0 0 0 1.7-1l2.4.7 2-3.5L19.4 15z"
      />
    </svg>
  );
}

export function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.3-4.3" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15z" />
    </svg>
  );
}


