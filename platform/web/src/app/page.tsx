import { PageHeader } from "@/components/ui/PageHeader";
import { SectionPanel } from "@/components/ui/SectionPanel";
import { InfoNote } from "@/components/ui/InfoNote";
import { WatchlistView } from "@/components/watchlist/WatchlistView";
import { PortfolioOverviewKpis } from "@/components/dashboard/PortfolioOverviewKpis";
import { AIActivityKpis } from "@/components/dashboard/AIActivityKpis";
import { RecentAIDecisionsList } from "@/components/dashboard/RecentAIDecisionsList";
import { QuickActionsPanel } from "@/components/dashboard/QuickActionsPanel";
import { MarketOverviewSummary } from "@/components/dashboard/MarketOverviewSummary";
import { instruments, paperPortfolio, marketStatus } from "@/lib/mock";
import { getStrategyEngine } from "@/lib/strategy-engine";
import { DotIcon } from "@/components/icons";

// Build 1.12.0 — rebuilt around one question: "What is my AI doing right now?" Every panel that
// used to configure something (browser/server automatic scanning) moved to Settings; this page now
// only observes and lets you trigger a scan or jump elsewhere. No trading logic, risk rule, or
// calculation changed — every figure here is read from the same functions/data the rest of the app
// already uses (see each component's own comments for exactly which one).
export default function DashboardPage() {
  const watchlistSnapshot = instruments.slice(0, 5);
  const strategyScores = getStrategyEngine().evaluateAll(instruments);

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="What your AI is doing right now, and how your paper portfolio is performing."
      />

      <SectionPanel title="Portfolio overview" description="Your simulated trading account, at a glance">
        <div className="px-5 pt-4">
          <PortfolioOverviewKpis paperPortfolio={paperPortfolio} />
        </div>
      </SectionPanel>

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
        This platform runs on simulated paper trading. No broker is connected, no real money is at
        risk, and nothing shown here is financial advice.
      </InfoNote>
    </>
  );
}
