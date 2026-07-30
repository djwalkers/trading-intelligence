import Link from "next/link";
import { PageHeader } from "@/components/ui/PageHeader";
import { SectionPanel } from "@/components/ui/SectionPanel";
import { InfoNote } from "@/components/ui/InfoNote";
import { WatchlistView } from "@/components/watchlist/WatchlistView";
import { HermesPortfolioSection } from "@/components/dashboard/HermesPortfolioSection";
import { AIActivityKpis } from "@/components/dashboard/AIActivityKpis";
import { RecentAIDecisionsList } from "@/components/dashboard/RecentAIDecisionsList";
import { QuickActionsPanel } from "@/components/dashboard/QuickActionsPanel";
import { MarketOverviewSummary } from "@/components/dashboard/MarketOverviewSummary";
import { instruments, marketStatus } from "@/lib/mock";
import { getStrategyEngine } from "@/lib/strategy-engine";
import { DotIcon } from "@/components/icons";

// Build 1.12.0 — rebuilt around one question: "What is my AI doing right now?" Every panel that
// used to configure something (browser/server automatic scanning) moved to Settings; this page now
// only observes and lets you trigger a scan or jump elsewhere.
//
// Main Dashboard Hermes/eToro fix. The portfolio section now represents the Hermes runtime's own
// connected eToro demo account (broker ground truth — see HermesPortfolioSection.tsx), not the
// legacy local paper-trading simulation `paperPortfolio` used to feed. That local simulation still
// exists, unmodified, at its own separate /portfolio route ("Local Paper Simulation") — it is
// deliberately never shown here any more, so the two account models are never mixed together on
// this page.
export default function DashboardPage() {
  const watchlistSnapshot = instruments.slice(0, 5);
  const strategyScores = getStrategyEngine().evaluateAll(instruments);

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="What your AI is doing right now, and how your Hermes/eToro demo account is performing."
      />

      <HermesPortfolioSection />

      <SectionPanel
        title="AI activity"
        description="Whether automatic scanning is running, and what it has done recently"
      >
        <div className="px-5 pt-4">
          <AIActivityKpis />
        </div>
      </SectionPanel>

      <SectionPanel
        title="Recent AI decisions"
        description="The AI Engine's most recent scans in this browser — accepted and rejected alike"
        viewAllHref="/bot-decisions"
      >
        <RecentAIDecisionsList />
      </SectionPanel>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <SectionPanel
            title="Market overview"
            description="Market status and a snapshot of your tracked instruments"
            viewAllHref="/watchlist"
          >
            <div className="flex items-center gap-2 px-5 pt-4 text-sm">
              <DotIcon className={marketStatus.isOpen ? "text-accent-teal" : "text-ink-500"} />
              <span className="text-ink-100">{marketStatus.label}</span>
              <span className="text-ink-500">&middot; {marketStatus.nextEvent}</span>
            </div>
            <div className="pt-3">
              <WatchlistView instruments={watchlistSnapshot} strategyScores={strategyScores} />
            </div>
            <MarketOverviewSummary />
          </SectionPanel>
        </div>

        <SectionPanel title="Quick actions" description="Trigger a scan or jump to another page">
          <QuickActionsPanel instruments={instruments} />
        </SectionPanel>
      </div>

      <InfoNote>
        The portfolio above reflects the Hermes runtime&apos;s own connected eToro <strong>demo</strong>{" "}
        account — a real demo broker connection, not simulated locally, but still no real money at
        risk (eToro demo accounts use virtual funds only). A separate,{" "}
        <Link href="/portfolio" className="text-ink-300 underline hover:text-ink-100">
          Local Paper Simulation
        </Link>{" "}
        also exists in this browser, entirely independent of the Hermes/eToro account above. Nothing
        shown here is financial advice.
      </InfoNote>
    </>
  );
}
