"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import Image from "next/image"
import { useRouter } from "next/navigation"

import { useAuth } from "@/contexts/auth-context"
import { fetchApi } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { LogoMark } from "@/components/logo-mark"

export function LoginClientPage() {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [isSubmitting, setIsSubmitting] = useState(false)
  const { login, user, isLoading } = useAuth()
  const router = useRouter()

  useEffect(() => {
    if (!isLoading && user) router.push("/dashboard")
  }, [isLoading, user, router])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")
    setIsSubmitting(true)
    try {
      const res = await fetchApi('/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      login(res.token, res.user);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsSubmitting(false)
    }
  };

  return (
    <div className="min-h-screen px-4 py-10">
      <div className="mx-auto w-full max-w-6xl">
        <div className="overflow-hidden rounded-3xl border bg-background shadow-sm">
          <div className="grid md:grid-cols-2">
            {/* Left: Form */}
            <div className="p-6 sm:p-10">
              <div className="mb-8 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <LogoMark className="h-10 w-10" title="Cashflow" />
                  <div className="leading-tight">
                    <div className="text-sm font-semibold">Cashflow</div>
                    <div className="text-xs text-muted-foreground">Accounting & Cash Management</div>
                  </div>
                </div>

                <div className="flex items-center gap-2 rounded-full border bg-muted/30 p-1">
                  <div className="rounded-full bg-background px-3 py-1 text-xs font-medium">Login</div>
                  <Link href="/register" className="rounded-full px-3 py-1 text-xs font-medium text-muted-foreground hover:text-foreground">
                    Sign Up
                  </Link>
                </div>
          </div>

              <div className="mb-6 space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
                <p className="text-sm text-muted-foreground">Please enter your details to log in.</p>
        </div>

              <Card className="shadow-none border-muted/60">
        <CardHeader>
          <CardTitle className="text-lg">Sign in</CardTitle>
                  <CardDescription>Use your email and password to continue.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="grid gap-4">
            <div className="grid gap-2">
                      <Label htmlFor="email">Email address</Label>
              <Input
                id="email"
                type="email"
                        placeholder="Enter your email address"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            <div className="grid gap-2">
                      <div className="flex items-center justify-between">
              <Label htmlFor="password">Password</Label>
                        <span className="text-xs text-muted-foreground">Forgot password?</span>
                      </div>
              <Input
                id="password"
                type="password"
                        placeholder="Enter your password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

                    {error ? <p className="text-sm text-destructive">{error}</p> : null}

            <Button className="w-full" type="submit" disabled={isSubmitting}>
                      {isSubmitting ? "Signing in..." : "Log In"}
            </Button>

                    <div className="text-center text-sm text-muted-foreground">
              Don&apos;t have an account?{" "}
                      <Link href="/register" className="font-medium text-foreground underline underline-offset-4">
                Sign up
              </Link>
            </div>
          </form>
        </CardContent>
        </Card>

              <p className="mt-6 text-center text-xs text-muted-foreground">
          By continuing, you agree to your internal company policies.
        </p>
            </div>

            {/* Right: Hero image */}
            <div className="relative hidden md:block">
              <div className="absolute inset-0 bg-gradient-to-br from-primary/15 via-transparent to-primary/10" />
              <Image
                src="/login-hero.svg"
                alt="Finance platform"
                fill
                priority
                className="object-cover"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

