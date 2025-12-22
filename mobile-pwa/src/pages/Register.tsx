import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { fetchApi } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { AuthResponse } from '../lib/types';

export default function Register() {
  const { login } = useAuth();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      const res = (await fetchApi('/register', {
        method: 'POST',
        body: JSON.stringify({ email, password, name, companyName })
      })) as AuthResponse;

      login(res.token, res.user);
      navigate('/', { replace: true });
    } catch (err: any) {
      setError(err?.message ?? 'Registration failed');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="min-h-dvh px-4 py-8">
      <div className="mx-auto w-full max-w-md">
        <div className="mb-6">
          <div className="text-sm text-slate-400">Cashflow</div>
          <h1 className="text-2xl font-semibold">Create account</h1>
          <p className="mt-1 text-sm text-slate-400">
            This calls your existing backend `POST /register`.
          </p>
        </div>

        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm text-slate-300">Full name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="w-full rounded-xl border border-slate-800 bg-slate-950 px-3 py-3 text-slate-100 outline-none focus:border-sky-500"
              placeholder="Your name"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm text-slate-300">Company name</label>
            <input
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              required
              className="w-full rounded-xl border border-slate-800 bg-slate-950 px-3 py-3 text-slate-100 outline-none focus:border-sky-500"
              placeholder="Your company"
            />
          </div>

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
              placeholder="8+ chars with upper/lower/number"
              autoComplete="new-password"
            />
          </div>

          {error ? <div className="text-sm text-rose-400">{error}</div> : null}

          <button
            disabled={isSubmitting}
            className="w-full rounded-xl bg-emerald-400 px-4 py-3 text-sm font-semibold text-slate-950 disabled:opacity-60"
            type="submit"
          >
            {isSubmitting ? 'Creating…' : 'Create account'}
          </button>

          <div className="text-center text-sm text-slate-400">
            Already have an account?{' '}
            <Link to="/login" className="text-slate-200 underline underline-offset-4">
              Sign in
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}


