import { PageHeader } from "@/components/ui/PageHeader";
import { SectionPanel } from "@/components/ui/SectionPanel";
import { StatCard } from "@/components/ui/StatCard";
import { InfoNote } from "@/components/ui/InfoNote";
import { SignalsTable } from "@/components/tables/SignalsTable";
import { signals } from "@/lib/mock";

export const metadata = {
  title: "Signals | Trading Intelligence Platform",
};

export default function SignalsPage() {
  const buyCount = signals.filter((signal) => signal.signalType === "BUY").length;
  const sellCount = signals.filter((signal) => signal.signalType === "SELL").length;
  const holdCount = signals.filter((signal) => signal.signalType === "HOLD").length;

  return (
    <>
      <PageHeader
        title="Signals"
        description="A simplified, manual signal feed generated from sample market data — separate from the AI Engine's own automatic scanning."
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Buy signals" value={String(buyCount)} />
        <StatCard label="Sell signals" value={String(sellCount)} />
        <StatCard label="Hold signals" value={String(holdCount)} />
      </div>

      <SectionPanel title="All signals" description={`${signals.length} generated`}>
        <SignalsTable signals={signals} />
      </SectionPanel>

      <InfoNote>
        These signals come from a simplified, manually-reviewed strategy feed over sample market
        data — a separate system from the AI Engine described on the Dashboard and Operations
        Centre. They do not reflect real market conditions and are not a recommendation to buy or
        sell any instrument.
      </InfoNote>
    </>
  );
}
