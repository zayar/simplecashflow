"use client"

import Image from "next/image"
import Link from "next/link"
import {
  ArrowRight,
  BadgeCheck,
  Banknote,
  Boxes,
  Braces,
  CreditCard,
  FileText,
  KeyRound,
  Layers,
  RadioTower,
  ReceiptText,
  ShieldCheck,
  Sparkles,
  Star,
  Wallet,
  Workflow,
} from "lucide-react"

import { LogoMark } from "@/components/logo-mark"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

const container = "mx-auto w-full max-w-6xl px-4"

function GlowBg() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <div className="absolute -top-40 left-1/2 h-[520px] w-[900px] -translate-x-1/2 rounded-full bg-gradient-to-r from-primary/18 via-fuchsia-500/10 to-cyan-500/10 blur-3xl" />
      <div className="absolute -top-10 right-[-140px] h-[420px] w-[420px] rounded-full bg-gradient-to-br from-primary/14 to-transparent blur-3xl" />
      <div className="absolute -bottom-56 left-[-240px] h-[520px] w-[520px] rounded-full bg-gradient-to-br from-cyan-500/12 to-transparent blur-3xl" />
      <div className="absolute inset-0 bg-[linear-gradient(to_right,hsl(var(--border))_1px,transparent_1px),linear-gradient(to_bottom,hsl(var(--border))_1px,transparent_1px)] bg-[size:52px_52px] opacity-[0.14]" />
    </div>
  )
}

export function MarketingNavbar() {
  const navItems = [
    { href: "#features", label: "Features" },
    { href: "#how", label: "How it works" },
    { href: "#modules", label: "Modules" },
    { href: "#integrations", label: "Integrations" },
    { href: "#developers", label: "Developers" },
  ]

  return (
    <header className="sticky top-0 z-40 border-b bg-background/70 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className={cn(container, "flex h-16 items-center justify-between")}>
        <Link href="/" className="flex items-center gap-2">
          <LogoMark className="h-8 w-8" title="Cashflow App" />
          <div className="leading-tight">
            <div className="text-sm font-semibold tracking-tight">Cashflow App</div>
            <div className="text-[11px] text-muted-foreground">Ledger-first finance platform</div>
          </div>
        </Link>

        <nav className="hidden items-center gap-6 text-sm text-muted-foreground lg:flex">
          {navItems.map((item) => (
            <Link key={item.href} href={item.href} className="hover:text-foreground">
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-3">
          <Link href="#developers" className="hidden text-sm text-muted-foreground hover:text-foreground sm:inline">
            Docs
          </Link>
          <Link
            href="/login"
            className={cn(
              buttonVariants({ size: "sm" }),
              "relative overflow-hidden",
              "bg-gradient-to-r from-primary to-primary/85 shadow-sm shadow-primary/20"
            )}
          >
            Login
          </Link>
        </div>
      </div>
    </header>
  )
}

export function HeroSection() {
  return (
    <section className="relative pb-14 pt-10 md:pb-20 md:pt-16">
      <GlowBg />
      <div className={container}>
        <div className="grid gap-10 lg:grid-cols-2 lg:items-center">
          <div className="space-y-6">
            <div className="inline-flex items-center gap-2 rounded-full border bg-background/70 px-3 py-1 text-xs font-medium text-muted-foreground shadow-sm">
              <Sparkles className="h-4 w-4 text-primary" />
              Built for retries, audits, and multi-tenant safety
              <span className="ml-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
                2026-ready
              </span>
            </div>

            <h1 className="text-balance text-4xl font-semibold leading-[1.05] tracking-tight sm:text-5xl">
              Ship finance workflows that stay{" "}
              <span className="bg-gradient-to-r from-primary via-fuchsia-500 to-cyan-500 bg-clip-text text-transparent">
                correct
              </span>{" "}
              under pressure.
            </h1>

            <p className="text-pretty text-lg text-muted-foreground">
              Cashflow App combines an <span className="font-medium text-foreground">immutable ledger</span>,{" "}
              <span className="font-medium text-foreground">idempotency keys</span>, tenant enforcement, and an{" "}
              <span className="font-medium text-foreground">outbox → Pub/Sub</span> event stream — powering invoices,
              expenses, inventory WAC, reports, and integrations like Piti.
            </p>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <Link
                href="/login"
                className={cn(
                  buttonVariants({ size: "lg" }),
                  "gap-2 bg-gradient-to-r from-primary to-primary/85 shadow-sm shadow-primary/20"
                )}
              >
                Login
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="#developers"
                className={cn(buttonVariants({ size: "lg", variant: "outline" }), "gap-2 bg-background/70")}
              >
                API guide
                <Braces className="h-4 w-4" />
              </Link>
            </div>

            <div className="flex flex-wrap items-center gap-3 pt-2 text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-2 rounded-full border bg-background/70 px-3 py-1">
                <Star className="h-4 w-4 text-primary" />
                Audit-ready ledger
              </span>
              <span className="inline-flex items-center gap-2 rounded-full border bg-background/70 px-3 py-1">
                <KeyRound className="h-4 w-4 text-primary" />
                Retry-safe writes
              </span>
              <span className="inline-flex items-center gap-2 rounded-full border bg-background/70 px-3 py-1">
                <RadioTower className="h-4 w-4 text-primary" />
                Event-driven sync
              </span>
            </div>
          </div>

          {/* Right: collage / bento visuals */}
          <div className="relative">
            <div aria-hidden className="absolute inset-0 -z-10 rounded-3xl bg-gradient-to-br from-primary/10 via-background to-cyan-500/10 blur-xl" />
            <div className="grid gap-4 sm:grid-cols-2">
              <Card className="overflow-hidden border-primary/20 bg-background/70 shadow-lg">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-xs font-semibold text-primary">Ledger snapshot</div>
                    <Badge variant="outline" className="rounded-full">
                      Immutable
                    </Badge>
                  </div>
                  <CardTitle className="text-lg">Append-only journaling</CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="rounded-xl border bg-muted/20 p-3 font-mono text-xs text-muted-foreground">
                    <div className="flex items-center justify-between">
                      <span>journalEntryId</span>
                      <span className="text-foreground">82119</span>
                    </div>
                    <div className="mt-2 flex items-center justify-between">
                      <span>hash</span>
                      <span className="text-foreground">f2c3:7c9a::1b</span>
                    </div>
                    <div className="mt-2 flex items-center justify-between">
                      <span>reversalOnly</span>
                      <span className="text-foreground">true</span>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className="overflow-hidden border-border/70 bg-background/70 shadow-lg">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-xs font-semibold text-primary">Outbox → Pub/Sub</div>
                    <Badge variant="secondary" className="rounded-full">
                      Events
                    </Badge>
                  </div>
                  <CardTitle className="text-lg">Guaranteed delivery</CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="space-y-2 rounded-xl border bg-muted/20 p-3 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-muted-foreground">invoice.posted</span>
                      <span className="rounded bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                        delivered
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-muted-foreground">inventory.adjusted</span>
                      <span className="rounded bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700">
                        queued
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-muted-foreground">piti.settled</span>
                      <span className="rounded bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700">
                        fan-out
                      </span>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className="sm:col-span-2 overflow-hidden border-border/70 bg-background/70 shadow-lg">
                <CardContent className="p-0">
                  <div className="relative grid gap-0 sm:grid-cols-[1.2fr,0.8fr]">
                    <div className="p-6">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-xs font-semibold text-primary">UI modules</div>
                        <Badge variant="outline" className="rounded-full">
                          Ops-ready
                        </Badge>
                      </div>
                      <div className="mt-2 text-lg font-semibold tracking-tight">Invoices, Expenses, Inventory WAC</div>
                      <p className="mt-2 text-sm text-muted-foreground">
                        Everything ties back to the ledger — with idempotency on write endpoints by default.
                      </p>
                      <div className="mt-4 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                        <div className="inline-flex items-center gap-2 rounded-lg border bg-muted/20 px-3 py-2">
                          <FileText className="h-4 w-4 text-primary" /> Invoices
                        </div>
                        <div className="inline-flex items-center gap-2 rounded-lg border bg-muted/20 px-3 py-2">
                          <ReceiptText className="h-4 w-4 text-primary" /> Expenses
                        </div>
                        <div className="inline-flex items-center gap-2 rounded-lg border bg-muted/20 px-3 py-2">
                          <Boxes className="h-4 w-4 text-primary" /> Inventory
                        </div>
                        <div className="inline-flex items-center gap-2 rounded-lg border bg-muted/20 px-3 py-2">
                          <Banknote className="h-4 w-4 text-primary" /> Reports
                        </div>
                      </div>
                    </div>
                    <div className="relative min-h-[220px]">
                      <div className="absolute inset-0 bg-gradient-to-br from-primary/15 via-transparent to-cyan-500/10" />
                      <Image
                        src="/login-hero.svg"
                        alt="Product preview"
                        fill
                        className="object-cover opacity-90"
                        priority
                      />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

export function SocialProofSection() {
  const logos = ["Piti", "Wallet Partners", "Retail Ops", "FinOps Teams", "Integrations"]
  const stats = [
    { value: "99.99%", label: "idempotent retries handled" },
    { value: "0", label: "silent cross-tenant leaks (by design)" },
    { value: "< 1s", label: "event publish latency (outbox→pubsub)" },
  ]

  return (
    <section className="pb-14">
      <div className={container}>
        <div className="rounded-3xl border bg-background/70 p-6 shadow-sm">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm font-semibold tracking-tight">
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <BadgeCheck className="h-4 w-4" />
                </span>
                Trusted rails for finance + engineering
              </div>
              <div className="text-sm text-muted-foreground">
                Designed for commercial use: resilient posting, clean audits, and predictable integrations.
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {logos.map((l) => (
                <span
                  key={l}
                  className="rounded-full border bg-muted/20 px-3 py-1 text-xs font-medium text-muted-foreground"
                >
                  {l}
                </span>
              ))}
            </div>
          </div>

          <Separator className="my-6" />

          <div className="grid gap-4 sm:grid-cols-3">
            {stats.map((s) => (
              <div key={s.label} className="rounded-2xl border bg-muted/10 p-5">
                <div className="text-2xl font-semibold tracking-tight">{s.value}</div>
                <div className="mt-1 text-sm text-muted-foreground">{s.label}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

export function FeaturesSection() {
  return (
    <section id="features" className="pb-16">
      <div className={container}>
        <div className="mb-8 space-y-3">
          <Badge variant="outline" className="rounded-full bg-background/70">
            Why it feels “enterprise” in production
          </Badge>
          <h2 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
            A commercial-grade core — not a demo UI
          </h2>
          <p className="text-lg text-muted-foreground">
            Reliability primitives that make finance workflows boring (in the best way): consistent, auditable, and fast.
          </p>
        </div>

        {/* Bento grid */}
        <div className="grid gap-4 lg:grid-cols-12">
          <Card className="lg:col-span-7 border-primary/20 bg-gradient-to-br from-primary/8 via-background to-background">
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <div className="inline-flex items-center gap-2 text-sm font-semibold text-primary">
                  <ShieldCheck className="h-4 w-4" />
                  Immutable ledger
                </div>
                <Badge className="rounded-full">Audit</Badge>
              </div>
              <CardTitle className="text-2xl">Append-only journaling with reversal workflows</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>
                Corrections are reversals, not destructive edits. Chained hashes make tampering evident and audits simpler.
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="rounded-xl border bg-background/70 p-3">
                  <div className="text-xs font-semibold text-foreground">Reversal-only policy</div>
                  <div className="mt-1 text-xs">No hidden edits. Every change is a tracked entry.</div>
                </div>
                <div className="rounded-xl border bg-background/70 p-3">
                  <div className="text-xs font-semibold text-foreground">Audit trail</div>
                  <div className="mt-1 text-xs">Who/what/when preserved for every post action.</div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="lg:col-span-5 border-border/70 bg-background/70">
            <CardHeader>
              <div className="inline-flex items-center gap-2 text-sm font-semibold text-primary">
                <KeyRound className="h-4 w-4" />
                Idempotency keys
              </div>
              <CardTitle className="text-2xl">Retry-safe writes by default</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>Double-clicks, flaky mobile networks, queue retries — all converge to one canonical result.</p>
              <div className="rounded-xl border bg-muted/20 p-3 font-mono text-xs">
                <div className="text-muted-foreground">Idempotency-Key</div>
                <div className="mt-1 text-foreground">9f7b-4c3d-88b2</div>
              </div>
            </CardContent>
          </Card>

          <Card className="lg:col-span-5 border-border/70 bg-background/70">
            <CardHeader>
              <div className="inline-flex items-center gap-2 text-sm font-semibold text-primary">
                <Layers className="h-4 w-4" />
                Tenant enforcement
              </div>
              <CardTitle className="text-2xl">Company-scoped APIs</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>
                Every endpoint is prefixed with <span className="font-medium text-foreground">/companies/:companyId</span>.
                Isolation is structural, not optional.
              </p>
              <div className="rounded-xl border bg-muted/20 p-3 font-mono text-xs">
                <div className="text-foreground">GET /companies/42/reports/trial-balance</div>
              </div>
            </CardContent>
          </Card>

          <Card className="lg:col-span-7 border-primary/20 bg-gradient-to-br from-cyan-500/10 via-background to-background">
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <div className="inline-flex items-center gap-2 text-sm font-semibold text-primary">
                  <RadioTower className="h-4 w-4" />
                  Outbox → Pub/Sub
                </div>
                <Badge variant="outline" className="rounded-full">
                  Events
                </Badge>
              </div>
              <CardTitle className="text-2xl">Events that match the ledger</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>
                Emit domain events from an outbox so downstream integrations (Piti, wallets, reporting) are consistent and
                replayable.
              </p>
              <div className="grid gap-2 sm:grid-cols-3">
                <div className="rounded-xl border bg-background/70 p-3">
                  <div className="text-xs font-semibold text-foreground">invoice.posted</div>
                  <div className="mt-1 text-xs">Settlement & notifications.</div>
                </div>
                <div className="rounded-xl border bg-background/70 p-3">
                  <div className="text-xs font-semibold text-foreground">inventory.adjusted</div>
                  <div className="mt-1 text-xs">WAC stays accurate.</div>
                </div>
                <div className="rounded-xl border bg-background/70 p-3">
                  <div className="text-xs font-semibold text-foreground">expense.paid</div>
                  <div className="mt-1 text-xs">Bank + GL align.</div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  )
}

export function HowItWorksSection() {
  const steps = [
    {
      title: "Send a command",
      description: "POST to a tenant-scoped endpoint with JWT + Idempotency-Key.",
      icon: KeyRound,
    },
    {
      title: "Commit to the ledger",
      description: "Write append-only journal entries. Corrections are reversals.",
      icon: ShieldCheck,
    },
    {
      title: "Publish events",
      description: "Outbox entries stream to Pub/Sub and integrations safely.",
      icon: RadioTower,
    },
    {
      title: "Build read models",
      description: "Reports, inventory WAC, and dashboards stay consistent.",
      icon: Workflow,
    },
  ]

  return (
    <section id="how" className="pb-16">
      <div className={container}>
        <div className="mb-8 space-y-3">
          <Badge variant="outline" className="rounded-full bg-background/70">
            How it works
          </Badge>
          <h2 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
            Predictable workflows, from API to audit
          </h2>
          <p className="text-lg text-muted-foreground">
            The same flow powers invoices, expenses, purchase bills, and inventory movements — with safety rails built in.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {steps.map((s, i) => (
            <Card key={s.title} className="border-border/70 bg-background/70">
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <s.icon className="h-5 w-5" />
                  </div>
                  <div className="rounded-full border bg-muted/20 px-2 py-0.5 text-xs font-semibold text-muted-foreground">
                    0{i + 1}
                  </div>
                </div>
                <div className="mt-4 text-lg font-semibold">{s.title}</div>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{s.description}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  )
}

export function ModulesSection() {
  const modules = [
    { title: "Invoices", description: "Issue, post, collect. Always tied back to the ledger.", icon: FileText },
    { title: "Expenses", description: "Track spend, approvals, and payment status in one place.", icon: ReceiptText },
    { title: "Purchase Bills", description: "AP with posting + payment flows that match cash movement.", icon: CreditCard },
    { title: "Inventory WAC", description: "Weighted average costing across receipts, issues, and adjustments.", icon: Boxes },
    { title: "Reports", description: "Trial balance, cashflow, P&L, and balance sheet.", icon: Banknote },
  ]

  return (
    <section id="modules" className="pb-16">
      <div className={container}>
        <div className="mb-8 space-y-3">
          <Badge variant="outline" className="rounded-full bg-background/70">
            Modules
          </Badge>
          <h2 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
            Everything your operators need
          </h2>
          <p className="text-lg text-muted-foreground">
            A clean, modern UI backed by durable accounting primitives — built for real businesses.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {modules.map((m) => (
            <Card key={m.title} className="border-border/70 bg-background/70">
              <CardContent className="p-6">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <m.icon className="h-5 w-5" />
                  </div>
                  <div className="text-lg font-semibold">{m.title}</div>
                </div>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{m.description}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  )
}

export function IntegrationsSection() {
  return (
    <section id="integrations" className="pb-16">
      <div className={container}>
        <div className="grid gap-4 lg:grid-cols-12">
          <Card className="lg:col-span-7 border-primary/20 bg-gradient-to-br from-primary/8 via-background to-background">
            <CardContent className="p-8">
              <Badge variant="outline" className="rounded-full bg-background/70">
                Integrations
              </Badge>
              <h3 className="mt-4 text-3xl font-semibold tracking-tight">Piti + wallet-friendly events</h3>
              <p className="mt-3 text-base text-muted-foreground">
                Connect to Piti and downstream wallets using the same event stream. Settlements reconcile cleanly back to
                the immutable ledger.
              </p>
              <div className="mt-6 flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-2 rounded-full border bg-background/70 px-3 py-1 text-xs font-medium text-muted-foreground">
                  <Wallet className="h-4 w-4 text-primary" /> Wallet partners
                </span>
                <span className="inline-flex items-center gap-2 rounded-full border bg-background/70 px-3 py-1 text-xs font-medium text-muted-foreground">
                  <RadioTower className="h-4 w-4 text-primary" /> Pub/Sub fan-out
                </span>
                <span className="inline-flex items-center gap-2 rounded-full border bg-background/70 px-3 py-1 text-xs font-medium text-muted-foreground">
                  <BadgeCheck className="h-4 w-4 text-primary" /> Piti native
                </span>
              </div>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
                <Link
                  href="/login"
                  className={cn(
                    buttonVariants({ size: "lg" }),
                    "gap-2 bg-gradient-to-r from-primary to-primary/85 shadow-sm shadow-primary/20"
                  )}
                >
                  Login to connect
                  <ArrowRight className="h-4 w-4" />
                </Link>
                <Link href="#developers" className={cn(buttonVariants({ size: "lg", variant: "outline" }), "gap-2")}>
                  Read API notes
                  <Braces className="h-4 w-4" />
                </Link>
              </div>
            </CardContent>
          </Card>

          <Card className="lg:col-span-5 border-border/70 bg-background/70">
            <CardContent className="p-8">
              <div className="text-sm font-semibold text-primary">Event examples</div>
              <div className="mt-4 space-y-3 rounded-2xl border bg-muted/20 p-4 font-mono text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">event</span>
                  <span className="text-foreground">invoice.posted</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">companyId</span>
                  <span className="text-foreground">42</span>
                </div>
                <Separator className="my-2" />
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">event</span>
                  <span className="text-foreground">piti.settled</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">companyId</span>
                  <span className="text-foreground">42</span>
                </div>
              </div>
              <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
                Durable outbox records enable replay and backfills without double posting.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  )
}

export function DeveloperNotes() {
  return (
    <section id="developers" className="pb-16">
      <div className={container}>
        <div className="mb-8 space-y-3">
          <Badge variant="outline" className="rounded-full bg-background/70">
            Developers
          </Badge>
          <h2 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
            Integrate in hours, operate for years
          </h2>
          <p className="text-lg text-muted-foreground">
            JWT auth, tenant-safe routes, and idempotency headers. Keep your integration boring and reliable.
          </p>
        </div>

        <div className="grid gap-4 lg:grid-cols-12">
          <Card className="lg:col-span-7 border-border/70 bg-background/70">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-primary">Request template</div>
                <Badge variant="secondary" className="rounded-full">
                  JWT + Idempotency
                </Badge>
              </div>
              <div className="mt-4 rounded-2xl border bg-muted/20 p-4 font-mono text-xs leading-relaxed">
                <div className="text-foreground">POST /companies/:companyId/invoices</div>
                <div className="mt-2 text-muted-foreground">Authorization: Bearer &lt;JWT&gt;</div>
                <div className="text-muted-foreground">Idempotency-Key: &lt;uuid&gt;</div>
                <div className="text-muted-foreground">Content-Type: application/json</div>
                <div className="mt-2 text-muted-foreground">{"{ customerId, lines: [...], currency, amount }"}</div>
              </div>

              <div className="mt-6 grid gap-3 sm:grid-cols-2">
                <div className="rounded-2xl border bg-background/70 p-4">
                  <div className="text-sm font-semibold">Tenant isolation</div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    Every request is scoped to <span className="font-medium text-foreground">/companies/:companyId</span>.
                  </div>
                </div>
                <div className="rounded-2xl border bg-background/70 p-4">
                  <div className="text-sm font-semibold">Automatic idempotency</div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    The UI defaults to adding <span className="font-medium text-foreground">Idempotency-Key</span> for
                    writes to prevent duplicates.
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="lg:col-span-5 border-primary/20 bg-gradient-to-br from-cyan-500/10 via-background to-background">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-primary">What teams love</div>
                <Badge variant="outline" className="rounded-full bg-background/70">
                  Practical
                </Badge>
              </div>
              <div className="mt-4 space-y-3">
                <div className="rounded-2xl border bg-background/70 p-4">
                  <div className="text-sm font-semibold">No double-posting</div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    Retries converge to one result — critical for payments and inventory.
                  </div>
                </div>
                <div className="rounded-2xl border bg-background/70 p-4">
                  <div className="text-sm font-semibold">Ledger-aligned events</div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    Outbox → Pub/Sub ensures downstream services match your accounting truth.
                  </div>
                </div>
                <div className="rounded-2xl border bg-background/70 p-4">
                  <div className="text-sm font-semibold">Operator-friendly UI</div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    Invoices, expenses, and reporting built for daily use — not a prototype.
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  )
}

export function TestimonialsSection() {
  const testimonials = [
    {
      quote:
        "We stopped worrying about duplicate postings. Idempotency is just there — and audits finally feel sane.",
      name: "Ops Lead",
      title: "Multi-merchant retail",
    },
    {
      quote:
        "Tenant safety + event outbox made our wallet integration predictable. Replays are painless.",
      name: "Backend Engineer",
      title: "Payments platform",
    },
    {
      quote:
        "The UI is clean, fast, and actually matches how accountants work. Posting flows are crisp.",
      name: "Finance Manager",
      title: "Distribution business",
    },
  ]

  return (
    <section className="pb-16">
      <div className={container}>
        <div className="mb-8 space-y-3">
          <Badge variant="outline" className="rounded-full bg-background/70">
            Testimonials
          </Badge>
          <h2 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
            Built for real operators
          </h2>
          <p className="text-lg text-muted-foreground">Modern UX on top of durable accounting rails.</p>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          {testimonials.map((t) => (
            <Card key={t.quote} className="border-border/70 bg-background/70">
              <CardContent className="p-6">
                <div className="flex items-center gap-1 text-primary" aria-hidden>
                  <Star className="h-4 w-4 fill-current" />
                  <Star className="h-4 w-4 fill-current" />
                  <Star className="h-4 w-4 fill-current" />
                  <Star className="h-4 w-4 fill-current" />
                  <Star className="h-4 w-4 fill-current" />
                </div>
                <p className="mt-4 text-sm leading-relaxed text-muted-foreground">“{t.quote}”</p>
                <div className="mt-6 flex items-center gap-3">
                  <div className="h-10 w-10 rounded-full bg-gradient-to-br from-primary/25 to-cyan-500/20" aria-hidden />
                  <div className="leading-tight">
                    <div className="text-sm font-semibold">{t.name}</div>
                    <div className="text-xs text-muted-foreground">{t.title}</div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  )
}

export function FinalCTASection() {
  return (
    <section className="pb-20">
      <div className={container}>
        <Card className="overflow-hidden border-primary/20 bg-gradient-to-br from-primary/10 via-background to-cyan-500/10">
          <CardContent className="relative p-8 md:p-10">
            <div aria-hidden className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(99,102,241,0.18),transparent_55%)]" />
            <div className="relative flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
              <div className="space-y-2">
                <div className="inline-flex items-center gap-2 text-sm font-semibold text-primary">
                  <BadgeCheck className="h-4 w-4" />
                  Ready to use in production
                </div>
                <div className="text-3xl font-semibold tracking-tight">Make your finance workflows reliable.</div>
                <div className="text-sm text-muted-foreground">
                  Immutable ledger • idempotent writes • tenant-safe APIs • outbox → Pub/Sub events
                </div>
              </div>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <Link
                  href="/login"
                  className={cn(
                    buttonVariants({ size: "lg" }),
                    "gap-2 bg-gradient-to-r from-primary to-primary/85 shadow-sm shadow-primary/20"
                  )}
                >
                  Login
                  <ArrowRight className="h-4 w-4" />
                </Link>
                <Link href="#developers" className={cn(buttonVariants({ size: "lg", variant: "outline" }), "gap-2")}>
                  View API notes
                  <Braces className="h-4 w-4" />
                </Link>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </section>
  )
}

export function MarketingFooter() {
  return (
    <footer className="border-t bg-background/70">
      <div className={cn(container, "flex flex-col gap-4 py-10 md:flex-row md:items-center md:justify-between")}>
        <div className="flex items-center gap-2">
          <LogoMark className="h-7 w-7" title="Cashflow App" />
          <div className="leading-tight">
            <div className="text-sm font-semibold">Cashflow App</div>
            <div className="text-xs text-muted-foreground">v2026 marketing</div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
          <Link href="#features" className="hover:text-foreground">
            Features
          </Link>
          <Link href="#how" className="hover:text-foreground">
            How it works
          </Link>
          <Link href="#modules" className="hover:text-foreground">
            Modules
          </Link>
          <Link href="#integrations" className="hover:text-foreground">
            Integrations
          </Link>
          <Link href="#developers" className="hover:text-foreground">
            Developers
          </Link>
          <Link href="/login" className="text-primary hover:text-primary/80">
            Login
          </Link>
        </div>
      </div>
    </footer>
  )
}

