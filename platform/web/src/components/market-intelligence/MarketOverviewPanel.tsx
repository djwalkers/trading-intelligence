import { StatCard } from "@/components/ui/StatCard";
import type { MarketOverview, MarketStatus } from "@/lib/types";

interface MarketOverviewPanelProps {
  overview: MarketOverview;
  marketStatus: MarketStatus;
}

export function MarketOverviewPanel({ overview, marketStatus }: MarketOverviewPanelProps) {
  return (
    <div className="grid grid-cols-1 gap-4 px-5 py-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
      <StatCard
        label="Market status"
        value={marketStatus.isOpen ? "Open" : "Closed"}
        sublabel={marketStatus.nextEvent}
      />
      <StatCard
        label="Market regime"
        value={overview.regime}
        sublabel="Overall trend across tracked instruments"
      />
      <StatCard
        label="Market confidence"
        value={`${overview.confidencePercent}%`}
        sublabel="Composite of trend, momentum & breadth"
      />
      <StatCard
        label="Volatility"
        value={overview.volatility}
        sublabel="Relative to 20-day average range"
      />
      <StatCard
        label="Risk environment"
        value={overview.riskLevel}
        sublabel="Aggregate exposure risk assessment"
      />
    </div>
  );
}
