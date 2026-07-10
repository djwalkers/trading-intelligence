import { PageHeader } from "@/components/ui/PageHeader";
import { StatCard } from "@/components/ui/StatCard";
import { SectionPanel } from "@/components/ui/SectionPanel";
import { InfoNote } from "@/components/ui/InfoNote";
import { SignalsTable } from "@/components/tables/SignalsTable";
import { WatchlistView } from "@/components/watchlist/WatchlistView";
import { SystemHealthList } from "@/components/tables/SystemHealthList";
import { PaperTradingSummary } from "@/components/dashboard/PaperTradingSummary";
import { IntelligenceSummaryCard } from "@/components/dashboard/IntelligenceSummaryCard";
import { MarketDataStatusCard } from "@/components/dashboard/MarketDataStatusCard";
import { StrategyEngineSummaryCard } from "@/components/dashboard/StrategyEngineSummaryCard";
import { BotRunnerPanel } from "@/components/dashboard/BotRunnerPanel";
import { ServerSchedulePanel } from "@/components/dashboard/ServerSchedulePanel";
import {
  instruments,
  opportunities,
  paperPortfolio,
  signals,
  strategies,
  systemServices,
  marketStatus,
} from "@/lib/mock";
import { formatCurrencyGBP, formatPercent } from "@/lib/utils/format";
import { plToneClass } from "@/lib/utils/style";
import { summarizeIntelligenceScores } from "@/lib/utils/intelligence-score";
import { getStrategyEngine, summarizeStrategyScores } from "@/lib/strategy-engine";

export default function DashboardPage() {
  const activeStrategies = strategies.filter((strategy) => strategy.status === "active");
  const latestSignals = signals.slice(0, 4);
  const watchlistSnapshot = instruments.slice(0, 5);
  const runningServices = systemServices.filter((service) => service.state === "running").length;
  const intelligenceSummary = summarizeIntelligenceScores(opportunities);
  const strategyScores = getStrategyEngine().evaluateAll(instruments);
  const strategyEngineSummary = summarizeStrategyScores(strategyScores);

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="A single view of paper portfolio performance, active strategies, and today's signals."
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Market status" value={marketStatus.isOpen ? "Open" : "Closed"} sublabel={marketStatus.nextEvent} />
        <StatCard
          label="Paper portfolio value"
          value={formatCurrencyGBP(paperPortfolio.currentValue)}
          sublabel={`Started at ${formatCurrencyGBP(paperPortfolio.startingValue)}`}
        />
        <StatCard
          label="Today's paper P/L"
          value={formatCurrencyGBP(paperPortfolio.dailyPl)}
          sublabel={formatPercent(paperPortfolio.dailyPlPercent)}
          subValueClassName={plToneClass(paperPortfolio.dailyPl)}
        />
        <StatCard
          label="Active strategies"
          value={String(activeStrategies.length)}
          sublabel={`${runningServices} of ${systemServices.length} services running`}
        />
      </div>

      <SectionPanel
        title="Paper trading performance"
        description="Open and closed paper trades placed from Signals and Market Intelligence"
        viewAllHref="/portfolio"
      >
        <PaperTradingSummary />
      </SectionPanel>

      <SectionPanel
        title="Intelligence summary"
        description="Today's opportunities, scored 0-100 across seven factors"
        viewAllHref="/market-intelligence"
      >
        <IntelligenceSummaryCard summary={intelligenceSummary} />
      </SectionPanel>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <SectionPanel
            title="Latest signals"
            description="Most recent output from active strategies"
            viewAllHref="/signals"
          >
            <SignalsTable signals={latestSignals} />
          </SectionPanel>
        </div>

        <SectionPanel title="System health" description="Live status of platform services" viewAllHref="/system-health">
          <SystemHealthList services={systemServices} />
        </SectionPanel>
      </div>

      <SectionPanel title="Watchlist snapshot" description="Tracked instruments at a glance" viewAllHref="/watchlist">
        <WatchlistView instruments={watchlistSnapshot} strategyScores={strategyScores} />
      </SectionPanel>

      <SectionPanel
        title="Market Data Status"
        description="Where instrument prices are currently sourced from"
        viewAllHref="/system-health"
      >
        <MarketDataStatusCard />
      </SectionPanel>

      <SectionPanel
        title="Strategy Summary"
        description="Deterministic Strategy Engine output across every tracked instrument"
        viewAllHref="/market-intelligence"
      >
        <StrategyEngineSummaryCard summary={strategyEngineSummary} />
      </SectionPanel>

      <SectionPanel
        title="Bot Runner"
        description="Manually-triggered autonomous paper trading — one scan, at most one trade"
        viewAllHref="/bot-decisions"
      >
        <BotRunnerPanel instruments={instruments} />
      </SectionPanel>

      <SectionPanel
        title="Server schedule"
        description="Runs on the VPS worker (Mission 8), independently of this browser tab — see System Health"
        viewAllHref="/system-health"
      >
        <ServerSchedulePanel />
      </SectionPanel>

      <InfoNote>
        This dashboard runs entirely on mock data for prototyping purposes. No broker is connected, no
        real money is at risk, and nothing shown here is financial advice.
      </InfoNote>
    </>
  );
}
