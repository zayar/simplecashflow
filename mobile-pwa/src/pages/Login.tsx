import React, { useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { fetchApi } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { AuthResponse } from '../lib/types';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation() as any;
  const [search] = useSearchParams();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const banner = useMemo(() => {
    const reason = search.get('reason');
    if (reason === 'expired') return 'Session expired. Please log in again.';
    return null;
  }, [search]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      const res = (await fetchApi('/login', {
        method: 'POST',
        body: JSON.stringify({ email, password })
      })) as AuthResponse;

      login(res.token, res.user);
      navigate(location?.state?.from ?? '/', { replace: true });
    } catch (err: any) {
      setError(err?.message ?? 'Login failed');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="min-h-dvh px-4 py-8">
      <div className="mx-auto w-full max-w-md">
        <div className="mb-6">
          <div className="text-sm text-slate-400">Cashflow</div>
          <h1 className="text-2xl font-semibold">Sign in</h1>
          <p className="mt-1 text-sm text-slate-400">Use your existing backend account.</p>
        </div>

        {banner ? (
          <div className="mb-4 rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-3 text-sm text-slate-200">
            {banner}
          </div>
        ) : null}

        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm text-slate-300">Email</label>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              required
              className="w-full rounded-xl border border-slate-800 bg-slate-950 px-3 py-3 text-slate-100 outline-none focus:border-sky-500"
              placeholder="you@company.com"
              autoComplete="email"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm text-slate-300">Password</label>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              required
              className="w-full rounded-xl border border-slate-800 bg-slate-950 px-3 py-3 text-slate-100 outline-none focus:border-sky-500"
              placeholder="••••••••"
              autoComplete="current-password"
            />
            <p className="mt-2 text-xs text-slate-500">
              Backend policy requires 8+ chars with upper/lower/number.
            </p>
          </div>

          {error ? <div className="text-sm text-rose-400">{error}</div> : null}

          <button
            disabled={isSubmitting}
            className="w-full rounded-xl bg-sky-500 px-4 py-3 text-sm font-semibold text-slate-950 disabled:opacity-60"
            type="submit"
          >
            {isSubmitting ? 'Signing in…' : 'Sign in'}
          </button>

          <div className="text-center text-sm text-slate-400">
            No account?{' '}
            <Link to="/register" className="text-slate-200 underline underline-offset-4">
              Create one
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}


