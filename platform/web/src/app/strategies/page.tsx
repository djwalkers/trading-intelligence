import { PageHeader } from "@/components/ui/PageHeader";
import { SectionPanel } from "@/components/ui/SectionPanel";
import { StatCard } from "@/components/ui/StatCard";
import { StrategyList } from "@/components/tables/StrategyList";
import { strategies } from "@/lib/mock";

export const metadata = {
  title: "Strategies | Trading Intelligence Platform",
};

export default function StrategiesPage() {
  const activeCount = strategies.filter((strategy) => strategy.status === "active").length;
  const backtestingCount = strategies.filter((strategy) => strategy.status === "backtesting").length;

  return (
    <>
      <PageHeader
        title="Strategies"
        description="Rule-based strategies that generate mock signals from simulated market data."
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Total strategies" value={String(strategies.length)} />
        <StatCard label="Active" value={String(activeCount)} />
        <StatCard label="Backtesting" value={String(backtestingCount)} />
      </div>

      <SectionPanel title="All strategies">
        <StrategyList strategies={strategies} />
      </SectionPanel>
    </>
  );
}
