import { PageHeader } from "@/components/ui/PageHeader";
import { StatCard } from "@/components/ui/StatCard";
import { SectionPanel } from "@/components/ui/SectionPanel";
import { InfoNote } from "@/components/ui/InfoNote";
import { SignalsTable } from "@/components/tables/SignalsTable";
import { WatchlistTable } from "@/components/tables/WatchlistTable";
import { SystemHealthList } from "@/components/tables/SystemHealthList";
import { PaperTradingSummary } from "@/components/dashboard/PaperTradingSummary";
import { instruments, paperPortfolio, signals, strategies, systemServices, marketStatus } from "@/lib/mock";
import { formatCurrencyGBP, formatPercent } from "@/lib/utils/format";
import { plToneClass } from "@/lib/utils/style";

export default function DashboardPage() {
  const activeStrategies = strategies.filter((strategy) => strategy.status === "active");
  const latestSignals = signals.slice(0, 4);
  const watchlistSnapshot = instruments.slice(0, 5);
  const runningServices = systemServices.filter((service) => service.state === "running").length;

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
        <WatchlistTable instruments={watchlistSnapshot} />
      </SectionPanel>

      <InfoNote>
        This dashboard runs entirely on mock data for prototyping purposes. No broker is connected, no
        real money is at risk, and nothing shown here is financial advice.
      </InfoNote>
    </>
  );
}
