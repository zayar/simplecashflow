import type { Metadata } from "next"

import {
  CTASection,
  FeaturesSection,
  HeroSection,
  MarketingFooter,
  MarketingNavbar,
  PricingSection,
  StepsSection,
  SupportSection,
  TestimonialsSection,
} from "@/components/marketing/sections"

export const metadata: Metadata = {
  title: "Cashflow App | Simple Accounting for Small Business",
  description:
    "Automate your bookkeeping and focus on growth. Simple, powerful accounting software trusted by 5,000+ businesses in 40+ countries. Start your 14-day free trial today.",
  openGraph: {
    title: "Cashflow App | Simple Accounting for Small Business",
    description:
      "Save time and get financial clarity with automated bookkeeping. Trusted by thousands of businesses worldwide. Try free for 14 days.",
    type: "website",
  },
}

export default function LandingPage() {
  return (
    <div className="min-h-screen">
      <MarketingNavbar />
      <main>
        <HeroSection />
        <StepsSection />
        <FeaturesSection />
        <PricingSection />
        <SupportSection />
        <TestimonialsSection />
        <CTASection />
      </main>
      <MarketingFooter />
    </div>
  )
}
