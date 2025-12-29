"use client"

import * as React from "react"
import Image from "next/image"
import Link from "next/link"
import {
  ArrowRight,
  BadgeCheck,
  BarChart3,
  CalendarCheck,
  ChevronRight,
  Headphones,
  LineChart,
  Sparkles,
  Star,
  Users,
} from "lucide-react"

import { LogoMark } from "@/components/logo-mark"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

const container = "mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8"

function GlowBackground() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <div className="absolute -top-48 left-1/2 h-[520px] w-[980px] -translate-x-1/2 rounded-full bg-gradient-to-r from-primary/22 via-emerald-500/10 to-teal-500/10 blur-3xl" />
      <div className="absolute -top-10 right-[-180px] h-[520px] w-[520px] rounded-full bg-gradient-to-br from-primary/14 to-transparent blur-3xl" />
      <div className="absolute -bottom-56 left-[-220px] h-[520px] w-[520px] rounded-full bg-gradient-to-br from-emerald-500/12 to-transparent blur-3xl" />
      <div className="absolute inset-0 bg-[linear-gradient(to_right,hsl(var(--border))_1px,transparent_1px),linear-gradient(to_bottom,hsl(var(--border))_1px,transparent_1px)] bg-[size:56px_56px] opacity-[0.14]" />
    </div>
  )
}

export function MarketingNavbar() {
  const nav = [
    { href: "#steps", label: "Steps" },
    { href: "#features", label: "Features" },
    { href: "#pricing", label: "Pricing" },
    { href: "#testimonials", label: "Reviews" },
  ]

  return (
    <header className="sticky top-0 z-50 border-b bg-background/70 backdrop-blur-xl supports-[backdrop-filter]:bg-background/60">
      <div className={cn(container, "flex h-16 items-center justify-between")}>
        <Link href="/" className="flex items-center gap-2.5">
          <LogoMark className="h-9 w-9" title="Cashflow" />
          <div className="leading-tight">
            <div className="text-sm font-semibold tracking-tight">Cashflow</div>
            <div className="text-[11px] text-muted-foreground">Simple accounting + operations</div>
          </div>
        </Link>

        <nav className="hidden items-center gap-7 text-sm font-medium text-muted-foreground md:flex">
          {nav.map((n) => (
            <Link key={n.href} href={n.href} className="transition-colors hover:text-foreground">
              {n.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-3">
          <Link href="/login" className="hidden text-sm font-medium text-muted-foreground hover:text-foreground sm:block">
            Sign in
          </Link>
          <Link
            href="/register"
            className={cn(
              buttonVariants({ size: "sm" }),
              "gap-1.5 bg-gradient-to-r from-primary to-primary/85 shadow-sm shadow-primary/20"
            )}
          >
            Get Started
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>
    </header>
  )
}

export function HeroSection() {
  return (
    <section className="relative overflow-hidden pb-14 pt-12 sm:pb-20 sm:pt-16">
      <GlowBackground />

      <div className={container}>
        <div className="mx-auto max-w-3xl text-center">
          <Badge variant="secondary" className="mx-auto w-fit rounded-full px-4 py-1.5 text-xs font-medium">
            <Sparkles className="mr-1.5 inline h-3.5 w-3.5" />
            Built for modern businesses
          </Badge>

          <h1 className="mt-6 text-balance text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl">
            Simplify your business operations
            <span className="bg-gradient-to-r from-primary via-emerald-500 to-teal-500 bg-clip-text text-transparent">
              {" "}
              with one powerful platform
            </span>
          </h1>

          <p className="mt-5 text-pretty text-lg leading-relaxed text-muted-foreground sm:text-xl">
            Track sales, purchases, inventory, and reports in one clean dashboard. Stay organized, save time, and make
            better decisions with clarity.
          </p>

          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              href="/register"
              className={cn(
                buttonVariants({ size: "lg" }),
                "gap-2 bg-gradient-to-r from-primary to-primary/85 shadow-lg shadow-primary/25"
              )}
            >
              Start Free Trial
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link href="#pricing" className={cn(buttonVariants({ size: "lg", variant: "outline" }), "gap-2")}>
              Book a Demo
              <ChevronRight className="h-4 w-4" />
            </Link>
          </div>

          <div className="mt-6 flex flex-wrap items-center justify-center gap-4 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-2 rounded-full border bg-background/70 px-3 py-1">
              <BadgeCheck className="h-4 w-4 text-primary" /> 14-day free trial
            </span>
            <span className="inline-flex items-center gap-2 rounded-full border bg-background/70 px-3 py-1">
              <BadgeCheck className="h-4 w-4 text-primary" /> No credit card required
            </span>
            <span className="inline-flex items-center gap-2 rounded-full border bg-background/70 px-3 py-1">
              <BadgeCheck className="h-4 w-4 text-primary" /> Cancel anytime
            </span>
          </div>
        </div>

        <div className="mt-10 sm:mt-14">
          <Card className="overflow-hidden border-border/70 bg-background/60 shadow-2xl">
            <CardContent className="relative p-0">
              <div aria-hidden className="absolute inset-0 bg-gradient-to-b from-primary/10 via-transparent to-transparent" />
              <Image
                src="/images/dashboard-preview.png"
                alt="Cashflow dashboard preview"
                width={1600}
                height={1000}
                className="h-auto w-full"
                priority
              />
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-background/70 to-transparent" />
            </CardContent>
          </Card>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-8 text-xs text-muted-foreground">
            <span className="rounded-full border bg-background/70 px-3 py-1">Operations</span>
            <span className="rounded-full border bg-background/70 px-3 py-1">Purchases</span>
            <span className="rounded-full border bg-background/70 px-3 py-1">Inventory</span>
            <span className="rounded-full border bg-background/70 px-3 py-1">Reports</span>
            <span className="rounded-full border bg-background/70 px-3 py-1">Integrations</span>
          </div>
        </div>
      </div>
    </section>
  )
}

export function StepsSection() {
  const steps = [
    {
      icon: Users,
      title: "Create Your Account",
      desc: "Sign up and set up your company in minutes.",
    },
    {
      icon: CalendarCheck,
      title: "Set Up Your Workspace",
      desc: "Add vendors, customers, and your starting balances.",
    },
    {
      icon: LineChart,
      title: "Track & Grow",
      desc: "Invoice, record bills, manage inventory, and view reports.",
    },
  ]

  return (
    <section id="steps" className="py-14 sm:py-20">
      <div className={container}>
        <div className="mx-auto max-w-2xl text-center">
          <Badge variant="outline" className="rounded-full">
            Get started in 3 simple steps
          </Badge>
          <h2 className="mt-4 text-balance text-3xl font-bold tracking-tight sm:text-4xl">
            Simple setup. Fast results.
          </h2>
          <p className="mt-3 text-lg text-muted-foreground">
            Designed for business owners—no complicated setup and no clutter.
          </p>
        </div>

        <div className="mt-10 grid gap-4 md:grid-cols-3">
          {steps.map((s, idx) => (
            <Card key={s.title} className="border-border/70 bg-background/70">
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <s.icon className="h-5 w-5" />
                  </div>
                  <div className="rounded-full border bg-muted/20 px-2 py-0.5 text-xs font-semibold text-muted-foreground">
                    0{idx + 1}
                  </div>
                </div>
                <div className="mt-4 text-lg font-semibold">{s.title}</div>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{s.desc}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  )
}

type FeatureTab = "Operations" | "Purchases" | "Inventory" | "Reports"

export function FeaturesSection() {
  const [tab, setTab] = React.useState<FeatureTab>("Operations")

  const content: Record<
    FeatureTab,
    { title: string; desc: string; bullets: string[]; accent: string; stat: { label: string; value: string } }
  > = {
    Operations: {
      title: "Run daily operations in one place",
      desc: "Stay on top of customers, invoices, and payments with a clean, fast UI.",
      bullets: ["Create invoices quickly", "Track collections", "Keep customer history organized"],
      accent: "from-emerald-500/12 to-teal-500/10",
      stat: { label: "Invoices created", value: "3.8k+" },
    },
    Purchases: {
      title: "Manage bills and supplier credits",
      desc: "Record bills, apply vendor credits, and keep payables accurate.",
      bullets: ["Purchase Bills", "Vendor Credits", "Clear payment status"],
      accent: "from-green-500/12 to-emerald-500/10",
      stat: { label: "Bills posted", value: "1.2k+" },
    },
    Inventory: {
      title: "Know what you have—always",
      desc: "Track stock movements and view inventory summaries without spreadsheets.",
      bullets: ["Inventory summary", "Stock adjustments", "Multi-location ready"],
      accent: "from-teal-500/12 to-emerald-500/10",
      stat: { label: "Items tracked", value: "450+" },
    },
    Reports: {
      title: "Get clarity with real-time reporting",
      desc: "Use built-in reports to understand performance and cash position.",
      bullets: ["Profit & Loss", "Balance Sheet", "Cashflow reports"],
      accent: "from-lime-500/12 to-emerald-500/10",
      stat: { label: "Reports generated", value: "12k+" },
    },
  }

  const tabs: FeatureTab[] = ["Operations", "Purchases", "Inventory", "Reports"]
  const d = content[tab]

  return (
    <section id="features" className="bg-muted/30 py-14 sm:py-20">
      <div className={container}>
        <div className="mx-auto max-w-2xl text-center">
          <Badge variant="outline" className="rounded-full">
            Everything you need to run and scale
          </Badge>
          <h2 className="mt-4 text-balance text-3xl font-bold tracking-tight sm:text-4xl">
            Built for growing businesses
          </h2>
          <p className="mt-3 text-lg text-muted-foreground">
            Clean workflows for day-to-day work, with reports that help you make better decisions.
          </p>
        </div>

        <div className="mt-10 flex flex-wrap items-center justify-center gap-2">
          {tabs.map((t) => {
            const active = t === tab
            return (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={cn(
                  "rounded-full border px-4 py-2 text-sm font-medium transition-colors",
                  active ? "bg-background text-foreground shadow-sm" : "bg-muted/20 text-muted-foreground hover:bg-background"
                )}
              >
                {t}
              </button>
            )
          })}
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-12 lg:items-stretch">
          <Card className="lg:col-span-5 border-border/70 bg-background/70">
            <CardContent className="p-8">
              <div className="text-xs font-semibold text-primary">Feature</div>
              <div className="mt-2 text-2xl font-semibold tracking-tight">{d.title}</div>
              <p className="mt-3 text-base text-muted-foreground">{d.desc}</p>

              <ul className="mt-6 space-y-3 text-sm text-muted-foreground">
                {d.bullets.map((b) => (
                  <li key={b} className="flex items-start gap-2">
                    <BadgeCheck className="mt-0.5 h-4 w-4 text-primary" />
                    <span>{b}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-8 flex items-center justify-between rounded-2xl border bg-muted/20 px-5 py-4">
                <div className="text-sm text-muted-foreground">{d.stat.label}</div>
                <div className="text-xl font-semibold tabular-nums">{d.stat.value}</div>
              </div>
            </CardContent>
          </Card>

          <Card className={cn("lg:col-span-7 overflow-hidden border-border/70 bg-background/70", "shadow-sm")}>
            <CardContent className="relative p-0">
              <div aria-hidden className={cn("absolute inset-0 bg-gradient-to-br", d.accent)} />
              <div className="relative grid gap-4 p-8 md:grid-cols-2">
                <Card className="border-border/60 bg-background/80">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">Quick overview</CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0 text-sm text-muted-foreground">
                    See the most important numbers at a glance with a clean dashboard.
                  </CardContent>
                </Card>
                <Card className="border-border/60 bg-background/80">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">Fast workflows</CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0 text-sm text-muted-foreground">
                    Less clicking, fewer forms, and clear actions for your team.
                  </CardContent>
                </Card>
                <div className="md:col-span-2">
                  <div className="rounded-2xl border bg-background/80 p-4">
                    <Image
                      src="/images/landing-illustration.svg"
                      alt="Illustration"
                      width={1200}
                      height={520}
                      className="h-auto w-full"
                    />
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

export function PricingSection() {
  const [billing, setBilling] = React.useState<"monthly" | "yearly">("monthly")

  const price = (m: number) => (billing === "monthly" ? m : Math.round(m * 10)) // simple discount

  const tiers = [
    {
      name: "Starter",
      price: price(19),
      desc: "For solo founders and small shops.",
      features: ["Invoices & customers", "Basic reporting", "Email support"],
      highlight: false,
    },
    {
      name: "Professional",
      price: price(49),
      desc: "Best for growing teams.",
      features: ["Purchase bills & credits", "Inventory tracking", "Advanced reports", "Priority support"],
      highlight: true,
    },
    {
      name: "Enterprise",
      price: price(99),
      desc: "For larger organizations.",
      features: ["Multi-location", "Custom roles", "Integrations", "Dedicated onboarding"],
      highlight: false,
    },
  ]

  return (
    <section id="pricing" className="py-14 sm:py-20">
      <div className={container}>
        <div className="mx-auto max-w-2xl text-center">
          <Badge variant="outline" className="rounded-full">
            Simple, transparent pricing
          </Badge>
          <h2 className="mt-4 text-balance text-3xl font-bold tracking-tight sm:text-4xl">
            Pick a plan that fits your business
          </h2>
          <p className="mt-3 text-lg text-muted-foreground">Upgrade anytime. No hidden fees.</p>

          <div className="mt-6 inline-flex items-center rounded-full border bg-muted/20 p-1 text-sm">
            <button
              type="button"
              onClick={() => setBilling("monthly")}
              className={cn(
                "rounded-full px-4 py-2 font-medium transition-colors",
                billing === "monthly" ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"
              )}
            >
              Monthly
            </button>
            <button
              type="button"
              onClick={() => setBilling("yearly")}
              className={cn(
                "rounded-full px-4 py-2 font-medium transition-colors",
                billing === "yearly" ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"
              )}
            >
              Yearly
            </button>
          </div>
        </div>

        <div className="mt-10 grid gap-4 lg:grid-cols-3">
          {tiers.map((t) => (
            <Card
              key={t.name}
              className={cn(
                "border-border/70 bg-background/70",
                t.highlight ? "ring-2 ring-primary/30 shadow-lg" : ""
              )}
            >
              <CardContent className="p-8">
                <div className="flex items-center justify-between">
                  <div className="text-lg font-semibold">{t.name}</div>
                  {t.highlight ? <Badge className="rounded-full">Most Popular</Badge> : null}
                </div>
                <div className="mt-2 text-sm text-muted-foreground">{t.desc}</div>
                <div className="mt-6 flex items-end gap-2">
                  <div className="text-4xl font-bold tracking-tight">${t.price}</div>
                  <div className="pb-1 text-sm text-muted-foreground">/ {billing === "monthly" ? "mo" : "yr"}</div>
                </div>
                <ul className="mt-6 space-y-3 text-sm text-muted-foreground">
                  {t.features.map((f) => (
                    <li key={f} className="flex items-start gap-2">
                      <BadgeCheck className="mt-0.5 h-4 w-4 text-primary" />
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-8">
                  <Link
                    href="/register"
                    className={cn(
                      buttonVariants({ size: "lg", variant: t.highlight ? "default" : "outline" }),
                      "w-full justify-center gap-2",
                      t.highlight ? "bg-gradient-to-r from-primary to-primary/85" : ""
                    )}
                  >
                    Get Started
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  )
}

export function SupportSection() {
  return (
    <section className="bg-muted/30 py-14 sm:py-20">
      <div className={container}>
        <div className="grid gap-8 lg:grid-cols-12 lg:items-center">
          <div className="lg:col-span-6">
            <Badge variant="outline" className="rounded-full">
              Our support
            </Badge>
            <h2 className="mt-4 text-balance text-3xl font-bold tracking-tight sm:text-4xl">
              A caring support team is here for you
            </h2>
            <p className="mt-3 text-lg text-muted-foreground">
              Get help when you need it—onboarding guidance, best practices, and fast responses.
            </p>
            <div className="mt-6 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/register"
                className={cn(
                  buttonVariants({ size: "lg" }),
                  "gap-2 bg-gradient-to-r from-primary to-primary/85 shadow-sm shadow-primary/20"
                )}
              >
                Get Started
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link href="#testimonials" className={cn(buttonVariants({ size: "lg", variant: "outline" }), "gap-2")}>
                See Reviews
                <ChevronRight className="h-4 w-4" />
              </Link>
            </div>
          </div>

          <div className="relative lg:col-span-6">
            <Card className="border-border/70 bg-background/70">
              <CardContent className="relative overflow-hidden p-10">
                <div aria-hidden className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(120,119,198,0.18),transparent_55%)]" />
                <div className="relative mx-auto flex max-w-sm items-center justify-center">
                  <div className="relative h-56 w-56 rounded-full border bg-background/70">
                    {/* simple “avatars” (no real photos) */}
                    {[
                      { top: "6%", left: "18%", label: "A" },
                      { top: "18%", right: "10%", label: "M" },
                      { bottom: "18%", left: "8%", label: "S" },
                      { bottom: "8%", right: "18%", label: "K" },
                    ].map((p, i) => (
                      <div
                        key={i}
                        className="absolute grid h-12 w-12 place-items-center rounded-full border bg-white text-sm font-semibold text-foreground shadow-sm"
                        style={p as any}
                        aria-hidden
                      >
                        {p.label}
                      </div>
                    ))}

                    <div className="absolute inset-0 grid place-items-center">
                      <div className="rounded-2xl border bg-white px-5 py-4 shadow-sm">
                        <div className="flex items-center gap-3">
                          <div className="grid h-10 w-10 place-items-center rounded-full bg-primary/10 text-primary">
                            <Headphones className="h-5 w-5" />
                          </div>
                          <div className="leading-tight">
                            <div className="text-sm font-semibold">Fast support</div>
                            <div className="text-xs text-muted-foreground">Real humans, real help</div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </section>
  )
}

export function TestimonialsSection() {
  const testimonials = [
    {
      quote: "We finally stopped using spreadsheets. Everything is clear and easy to track.",
      name: "Small business owner",
    },
    {
      quote: "Invoices, bills, and inventory are all in one place. The UI is clean and fast.",
      name: "Operations manager",
    },
    {
      quote: "Reports are simple to understand. I can see how my business is doing instantly.",
      name: "Founder",
    },
  ]

  return (
    <section id="testimonials" className="py-14 sm:py-20">
      <div className={container}>
        <div className="mx-auto max-w-2xl text-center">
          <Badge variant="outline" className="rounded-full">
            What our users are saying
          </Badge>
          <h2 className="mt-4 text-balance text-3xl font-bold tracking-tight sm:text-4xl">Loved by teams</h2>
          <p className="mt-3 text-lg text-muted-foreground">Simple, reliable, and easy to use.</p>
        </div>

        <div className="mt-10 grid gap-4 md:grid-cols-3">
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
                  <div className="grid h-10 w-10 place-items-center rounded-full bg-gradient-to-br from-primary/20 to-cyan-500/20">
                    <Users className="h-5 w-5 text-primary" />
                  </div>
                  <div className="text-sm font-semibold">{t.name}</div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  )
}

export function CTASection() {
  return (
    <section className="relative overflow-hidden bg-gradient-to-br from-primary via-emerald-600 to-teal-600 py-14 sm:py-20">
      <div aria-hidden className="absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.06)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.06)_1px,transparent_1px)] bg-[size:56px_56px]" />
      <div className={cn(container, "relative text-center")}>
        <h2 className="text-balance text-3xl font-bold tracking-tight text-white sm:text-4xl">
          Ready to grow your business digitally?
        </h2>
        <p className="mt-3 text-lg text-white/90">
          Start your free trial today. Upgrade anytime.
        </p>
        <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
          <Link href="/register" className={cn(buttonVariants({ size: "lg", variant: "secondary" }), "gap-2 shadow-xl")}>
            Start Free Trial
            <ArrowRight className="h-4 w-4" />
          </Link>
          <Link
            href="/login"
            className={cn(
              buttonVariants({ size: "lg", variant: "outline" }),
              "border-white/25 bg-white/10 text-white backdrop-blur-sm hover:bg-white/20"
            )}
          >
            Sign In
          </Link>
        </div>
      </div>
    </section>
  )
}

export function MarketingFooter() {
  return (
    <footer className="border-t bg-background/80">
      <div className={cn(container, "py-10")}>
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <div className="flex items-center gap-2">
              <LogoMark className="h-8 w-8" title="Cashflow" />
              <div className="text-base font-semibold">Cashflow</div>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              Clean accounting and operations tools for modern teams.
            </p>
          </div>
          <div>
            <div className="text-sm font-semibold">Product</div>
            <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
              <li><Link href="#features" className="hover:text-foreground">Features</Link></li>
              <li><Link href="#pricing" className="hover:text-foreground">Pricing</Link></li>
              <li><Link href="/login" className="hover:text-foreground">Sign in</Link></li>
            </ul>
          </div>
          <div>
            <div className="text-sm font-semibold">Company</div>
            <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
              <li><Link href="#testimonials" className="hover:text-foreground">Reviews</Link></li>
              <li><Link href="#steps" className="hover:text-foreground">Getting started</Link></li>
              <li><Link href="#pricing" className="hover:text-foreground">Plans</Link></li>
            </ul>
          </div>
          <div>
            <div className="text-sm font-semibold">Support</div>
            <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
              <li><Link href="#testimonials" className="hover:text-foreground">Help center</Link></li>
              <li><Link href="#pricing" className="hover:text-foreground">Contact</Link></li>
              <li><Link href="/register" className="hover:text-foreground">Get started</Link></li>
            </ul>
          </div>
        </div>

        <Separator className="my-8" />

        <div className="flex flex-col items-center justify-between gap-3 text-sm text-muted-foreground sm:flex-row">
          <div>© {new Date().getFullYear()} Cashflow App</div>
          <div className="flex items-center gap-2">
            <span className="rounded-full border bg-muted/20 px-3 py-1 text-xs">v2026 landing</span>
          </div>
        </div>
      </div>
    </footer>
  )
}

