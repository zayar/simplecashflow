import React from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';

export function TopBar({ title }: { title: string }) {
  const { user, logout } = useAuth();

  return (
    <div className="sticky top-0 z-10 border-b border-slate-800 bg-slate-950/80 backdrop-blur">
      <div className="mx-auto flex max-w-xl items-center justify-between px-4 py-3">
        <div className="flex items-baseline gap-2">
          <div className="h-2 w-2 rounded-full bg-emerald-400" />
          <div className="text-base font-semibold">{title}</div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-xs text-slate-400">
            {user ? `Company #${user.companyId}` : ''}
          </div>
          <Link
            to="/"
            className="rounded-lg px-2 py-1 text-xs text-slate-200 hover:bg-slate-900"
          >
            Home
          </Link>
          <button
            onClick={() => logout()}
            className="rounded-lg border border-slate-800 px-2 py-1 text-xs text-slate-200 hover:bg-slate-900"
          >
            Logout
          </button>
        </div>
      </div>
    </div>
  );
}


