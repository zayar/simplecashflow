import type { Metadata } from "next"

import {
  DeveloperNotes,
  FeaturesSection,
  HeroSection,
  HowItWorksSection,
  IntegrationsSection,
  MarketingFooter,
  MarketingNavbar,
  ModulesSection,
  SocialProofSection,
  TestimonialsSection,
  FinalCTASection,
} from "@/components/marketing/sections"
import { Separator } from "@/components/ui/separator"

export const metadata: Metadata = {
  title: "Cashflow App | Immutable ledger, idempotent APIs, tenant-safe",
  description:
    "Modern finance OS with immutable ledger, idempotency by default, tenant enforcement, and Pub/Sub outbox events for invoices, expenses, inventory WAC, and more.",
  openGraph: {
    title: "Cashflow App | Immutable ledger, idempotent APIs, tenant-safe",
    description:
      "Immutable accounting rails with outbox → Pub/Sub events, idempotent commands, and tenant-safe APIs for invoices, expenses, purchase bills, inventory WAC, reports, and integrations like Piti.",
    type: "website",
  },
}

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-background via-background to-muted/30">
      <MarketingNavbar />
      <main className="pb-2">
        <HeroSection />
        <SocialProofSection />
        <FeaturesSection />
        <Separator className="mx-auto max-w-6xl" />
        <HowItWorksSection />
        <ModulesSection />
        <IntegrationsSection />
        <TestimonialsSection />
        <DeveloperNotes />
        <FinalCTASection />
      </main>
      <MarketingFooter />
    </div>
  )
}

