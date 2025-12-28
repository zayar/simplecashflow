import * as React from 'react';
import { cn } from '../../lib/cn';

type TabsCtx = {
  value: string;
  setValue: (v: string) => void;
};

const Ctx = React.createContext<TabsCtx | null>(null);

export function Tabs({
  value,
  defaultValue,
  onValueChange,
  className,
  children
}: {
  value?: string;
  defaultValue?: string;
  onValueChange?: (v: string) => void;
  className?: string;
  children: React.ReactNode;
}) {
  const [internal, setInternal] = React.useState(defaultValue ?? '');
  const actual = value ?? internal;

  const setValue = React.useCallback(
    (v: string) => {
      if (onValueChange) onValueChange(v);
      if (value === undefined) setInternal(v);
    },
    [onValueChange, value]
  );

  return (
    <Ctx.Provider value={{ value: actual, setValue }}>
      <div className={cn('w-full', className)}>{children}</div>
    </Ctx.Provider>
  );
}

export function TabsList({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'inline-flex h-10 items-center justify-center rounded-md bg-muted p-1 text-muted-foreground',
        className
      )}
      {...props}
    />
  );
}

export function TabsTrigger({
  value,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { value: string }) {
  const ctx = React.useContext(Ctx);
  if (!ctx) throw new Error('TabsTrigger must be used within Tabs');
  const active = ctx.value === value;
  return (
    <button
      type="button"
      onClick={() => ctx.setValue(value)}
      className={cn(
        'inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
        active ? 'bg-background text-foreground shadow-sm' : 'hover:bg-background/50',
        className
      )}
      {...props}
    />
  );
}

export function TabsContent({
  value,
  className,
  children
}: {
  value: string;
  className?: string;
  children: React.ReactNode;
}) {
  const ctx = React.useContext(Ctx);
  if (!ctx) throw new Error('TabsContent must be used within Tabs');
  if (ctx.value !== value) return null;
  return <div className={cn('mt-2', className)}>{children}</div>;
}


