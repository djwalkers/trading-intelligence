import Link from "next/link";
import { PageHeader } from "@/components/ui/PageHeader";
import { SectionPanel } from "@/components/ui/SectionPanel";
import { InfoNote } from "@/components/ui/InfoNote";
import { WatchlistView } from "@/components/watchlist/WatchlistView";
import { HermesPortfolioSection } from "@/components/dashboard/HermesPortfolioSection";
import { QuickActionsPanel } from "@/components/dashboard/QuickActionsPanel";
import { MarketOverviewSummary } from "@/components/dashboard/MarketOverviewSummary";
import { instruments, marketStatus } from "@/lib/mock";
import { getStrategyEngine } from "@/lib/strategy-engine";
import { DotIcon } from "@/components/icons";

// Main Dashboard Hermes/eToro fix. The portfolio section represents the Hermes runtime's own
// connected eToro demo account (broker ground truth — see HermesPortfolioSection.tsx), not the
// legacy local paper-trading simulation `paperPortfolio`. That local simulation still exists,
// unmodified, at its own separate /portfolio route ("Local Paper Simulation") — it is deliberately
// never shown here, so the two account models are never mixed together on this page.
//
// Legacy-worker UI cleanup. This page previously also surfaced the legacy browser/server "AI
// activity" scanning status and a "Recent AI decisions" list — both entirely unrelated to the
// Hermes Agent/eToro pipeline above (see docs/audit/LEGACY_WORKER_IMPACT_ASSESSMENT.md). Both were
// removed from this primary operational view rather than deprecated-in-place, since their presence
// directly under the real Hermes portfolio section was the single clearest source of "is this what
// my broker account is doing?" confusion identified by the audit. The underlying legacy Strategy
// Simulator, its scan history, and its scheduling controls are not deleted — see /bot-decisions,
// /decision-intelligence, and Settings' own clearly-marked "Legacy paper-trading simulator"
// section. No fake Hermes-labelled replacement was added in their place.
export default function DashboardPage() {
  const watchlistSnapshot = instruments.slice(0, 5);
  const strategyScores = getStrategyEngine().evaluateAll(instruments);

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="How your Hermes/eToro demo account is performing right now."
      />

      <HermesPortfolioSection />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <SectionPanel
            title="Market overview"
            description="Sample instrument data and legacy strategy scores — separate from your Hermes/eToro account above"
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

        <SectionPanel title="Quick actions" description="Jump to another page">
          <QuickActionsPanel />
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
