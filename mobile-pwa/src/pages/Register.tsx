import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { fetchApi } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { AuthResponse } from '../lib/types';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Button } from '../components/ui/button';

export default function Register() {
  const { login } = useAuth();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
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
    <div className="min-h-dvh bg-background px-4 py-8">
      <div className="mx-auto w-full max-w-md">
        <div className="mb-6 text-center">
          <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-sm">
            <span className="text-lg font-semibold">CF</span>
          </div>
          <h1 className="mt-4 text-2xl font-semibold tracking-tight text-foreground">Create your account</h1>
          <p className="mt-1 text-sm text-muted-foreground">Get started in under a minute</p>
        </div>

        <Card className="rounded-2xl p-4 shadow-sm">
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-foreground">Full name</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Your name" autoComplete="name" />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-foreground">Company name</label>
              <Input
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                required
                placeholder="Your company"
                autoComplete="organization"
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-foreground">Email</label>
              <Input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                type="email"
                required
                placeholder="you@company.com"
                autoComplete="email"
                inputMode="email"
              />
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between">
                <label className="block text-sm font-medium text-foreground">Password</label>
                <button
                  type="button"
                  className="text-xs font-medium text-muted-foreground hover:text-foreground"
                  onClick={() => setShowPassword((v) => !v)}
                >
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </div>
              <Input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                type={showPassword ? 'text' : 'password'}
                required
                placeholder="8+ chars with upper/lower/number"
                autoComplete="new-password"
              />
              <p className="mt-2 text-xs text-muted-foreground">
                Password must be 8+ characters with upper/lowercase and a number.
              </p>
            </div>

            {error ? (
              <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            ) : null}

            <Button disabled={isSubmitting} className="w-full" type="submit">
              {isSubmitting ? 'Creating…' : 'Create account'}
            </Button>

            <div className="text-center text-sm text-muted-foreground">
              Already have an account?{' '}
              <Link to="/login" className="font-medium text-foreground underline underline-offset-4">
                Sign in
              </Link>
            </div>
          </form>
        </Card>

        <div className="mt-6 text-center text-xs text-muted-foreground">
          By creating an account, you agree to your company’s internal usage policy.
        </div>
      </div>
    </div>
  );
}


